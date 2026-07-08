from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from .db import get_session
from .models import Company, Delivery, Job, Vehicle, init_db
from .seed import seed_data

_db_ready = False


def ensure_db_ready() -> None:
    global _db_ready
    init_db()
    if not _db_ready:
        seed_data()
        _db_ready = True


def build_route_points(job: Job) -> List[List[float]]:
    start = [job.pickup_lat, job.pickup_lon]
    end = [job.dropoff_lat, job.dropoff_lon]

    if job.pickup_city == "Minneapolis" and job.dropoff_city == "Rochester":
        return [
            start,
            [44.9700, -93.2550],
            [44.9580, -93.2320],
            [44.9400, -93.2050],
            [44.9100, -93.1700],
            [44.8850, -93.1200],
            [44.8500, -93.0600],
            [44.8150, -93.0000],
            [44.7800, -92.9400],
            [44.7400, -92.8800],
            [44.7000, -92.8200],
            [44.6500, -92.7600],
            [44.5900, -92.7000],
            [44.5200, -92.6400],
            [44.4500, -92.5900],
            [44.3600, -92.5500],
            [44.2500, -92.5200],
            end,
        ]

    if job.pickup_city == "Chicago" and job.dropoff_city == "St. Louis":
        return [
            start,
            [41.8650, -87.9900],
            [41.8300, -88.0600],
            [41.7700, -88.1800],
            [41.7000, -88.3200],
            [41.6200, -88.5000],
            [41.5000, -88.7000],
            [41.3200, -88.9000],
            [41.0500, -89.1000],
            [40.7800, -89.3100],
            [40.4200, -89.5200],
            [39.9800, -89.7600],
            [39.6000, -89.9200],
            [39.1000, -90.0500],
            end,
        ]

    return [
        start,
        [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
        end,
    ]


def interpolate_along_route(route: List[List[float]], progress: float) -> Tuple[float, float]:
    if len(route) < 2:
        return route[0][0], route[0][1]

    if progress <= 0:
        return route[0][0], route[0][1]
    if progress >= 1:
        return route[-1][0], route[-1][1]

    total_length = 0.0
    segment_lengths: List[float] = []
    for index in range(len(route) - 1):
        segment = route[index + 1]
        prev = route[index]
        dx = segment[0] - prev[0]
        dy = segment[1] - prev[1]
        length = (dx * dx + dy * dy) ** 0.5
        segment_lengths.append(length)
        total_length += length

    if total_length == 0:
        return route[0][0], route[0][1]

    target_distance = progress * total_length
    traveled = 0.0
    for index, segment_length in enumerate(segment_lengths):
        if traveled + segment_length >= target_distance:
            prev = route[index]
            next_point = route[index + 1]
            remaining = target_distance - traveled
            ratio = remaining / segment_length if segment_length else 0.0
            lat = prev[0] + (next_point[0] - prev[0]) * ratio
            lon = prev[1] + (next_point[1] - prev[1]) * ratio
            return lat, lon
        traveled += segment_length

    return route[-1][0], route[-1][1]


def build_delivery_payload(session: Any, delivery: Delivery) -> Dict[str, Any]:
    job = session.get(Job, delivery.job_id)
    vehicle = session.get(Vehicle, delivery.vehicle_id)
    if not job or not vehicle:
        return {
            "id": delivery.id,
            "status": delivery.status,
            "origin": "",
            "destination": "",
            "eta": "Pending",
            "current_lat": None,
            "current_lon": None,
            "route": [],
        }

    started_at = delivery.started_at or datetime.now(timezone.utc)
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    elapsed_seconds = max(0.0, (datetime.now(timezone.utc) - started_at).total_seconds())
    duration_seconds = 90.0
    progress = min(1.0, elapsed_seconds / duration_seconds)
    route = build_route_points(job)
    current_lat, current_lon = interpolate_along_route(route, progress)
    remaining = max(0, int(duration_seconds - elapsed_seconds))
    if remaining >= 60:
        eta_text = f"{remaining // 60}m {remaining % 60}s"
    else:
        eta_text = f"{remaining}s"

    return {
        "id": delivery.id,
        "status": delivery.status,
        "origin": job.pickup_city,
        "destination": job.dropoff_city,
        "eta": eta_text,
        "current_lat": current_lat,
        "current_lon": current_lon,
        "route": route,
        "vehicle_name": vehicle.name,
    }

app = FastAPI(title="Logistics Simulator API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT.parent / "frontend"

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.on_event("startup")
def startup_event() -> None:
    ensure_db_ready()


class AssignmentPayload(BaseModel):
    vehicle_id: int


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "logistics-simulator"}


@app.get("/api/game-state")
def game_state() -> Dict[str, Any]:
    ensure_db_ready()
    with get_session() as session:
        company = session.query(Company).first()
        if not company:
            return {"company": None, "fleet_count": 0, "active_jobs": 0, "active_deliveries": 0, "simulation_time": ""}
        return {
            "company": {
                "name": company.name,
                "cash": company.cash,
                "reputation": company.reputation,
                "level": company.level,
            },
            "fleet_count": session.query(Vehicle).filter(Vehicle.company_id == company.id).count(),
            "active_jobs": session.query(Job).filter(Job.company_id == company.id, Job.status == "available").count(),
            "active_deliveries": session.query(Delivery).filter(Delivery.company_id == company.id, Delivery.status != "completed").count(),
            "simulation_time": "2026-07-07T08:00:00Z",
        }


@app.get("/api/vehicles")
def vehicles() -> List[Dict[str, Any]]:
    ensure_db_ready()
    with get_session() as session:
        rows = session.query(Vehicle).all()
        return [
            {
                "id": vehicle.id,
                "name": vehicle.name,
                "type": vehicle.vehicle_type,
                "status": vehicle.status,
                "current_city": vehicle.current_city,
                "fuel_level": vehicle.fuel_level,
                "current_lat": vehicle.current_lat,
                "current_lon": vehicle.current_lon,
            }
            for vehicle in rows
        ]


@app.get("/api/jobs")
def jobs() -> List[Dict[str, Any]]:
    ensure_db_ready()
    with get_session() as session:
        rows = session.query(Job).filter(Job.status == "available").all()
        return [
            {
                "id": job.id,
                "pickup_city": job.pickup_city,
                "dropoff_city": job.dropoff_city,
                "cargo_type": job.cargo_type,
                "reward": job.reward,
                "deadline_hours": job.deadline_hours,
                "urgency": job.urgency,
                "pickup_lat": job.pickup_lat,
                "pickup_lon": job.pickup_lon,
                "dropoff_lat": job.dropoff_lat,
                "dropoff_lon": job.dropoff_lon,
            }
            for job in rows
        ]


@app.get("/api/deliveries")
def deliveries() -> List[Dict[str, Any]]:
    ensure_db_ready()
    with get_session() as session:
        rows = session.query(Delivery).filter(Delivery.status != "completed").all()
        return [build_delivery_payload(session, delivery) for delivery in rows]


@app.get("/api/routes/estimate")
def estimate_route(origin: str, destination: str) -> Dict[str, Any]:
    return {
        "origin": origin,
        "destination": destination,
        "distance_km": 210,
        "estimated_minutes": 195,
        "traffic_delay_minutes": 28,
        "fuel_cost": 42.0,
    }


@app.post("/api/jobs/{job_id}/assign")
def assign_job(job_id: int, payload: AssignmentPayload) -> Dict[str, Any]:
    ensure_db_ready()
    with get_session() as session:
        job = session.query(Job).filter(Job.id == job_id).first()
        vehicle = session.query(Vehicle).filter(Vehicle.id == payload.vehicle_id).first()
        if not job or not vehicle:
            return {"status": "error", "message": "Job or vehicle not found"}

        job.status = "assigned"
        vehicle.status = "en_route"
        vehicle.current_lat = job.pickup_lat
        vehicle.current_lon = job.pickup_lon
        vehicle.current_city = job.pickup_city
        delivery = Delivery(
            company_id=job.company_id,
            job_id=job.id,
            vehicle_id=vehicle.id,
            status="in_transit",
            started_at=datetime.now(timezone.utc),
            distance_km=180.0,
            traffic_delay_minutes=25,
        )
        session.add(delivery)
        session.commit()

        return {
            "job_id": job.id,
            "vehicle_id": vehicle.id,
            "status": "assigned",
            "message": "Vehicle assigned to job",
        }
