from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .models import Company, Delivery, Job, Vehicle, engine, init_db


def seed_data() -> None:
    init_db()
    with Session(engine) as session:
        company = session.query(Company).first()
        if company:
            if session.query(Delivery).count() == 0:
                vehicle = session.query(Vehicle).first()
                job = session.query(Job).filter(Job.status == "available").order_by(Job.id).first()
                if vehicle and job:
                    job.status = "assigned"
                    vehicle.status = "en_route"
                    vehicle.current_city = job.pickup_city
                    vehicle.current_lat = job.pickup_lat
                    vehicle.current_lon = job.pickup_lon
                    delivery = Delivery(
                        company_id=company.id,
                        job_id=job.id,
                        vehicle_id=vehicle.id,
                        status="in_transit",
                        started_at=datetime.now(timezone.utc),
                        distance_km=180.0,
                        traffic_delay_minutes=25,
                    )
                    session.add(delivery)
                    session.commit()
            return

        company = Company(name="Northstar Freight", cash=100000.0, reputation=42, level=1)
        session.add(company)
        session.flush()

        vehicle = Vehicle(
            company_id=company.id,
            name="Van 01",
            vehicle_type="Cargo Van",
            status="idle",
            current_city="Minneapolis",
            fuel_level=78,
            current_lat=44.9778,
            current_lon=-93.2650,
        )
        session.add(vehicle)

        jobs = [
            Job(
                company_id=company.id,
                pickup_city="Minneapolis",
                pickup_lat=44.9778,
                pickup_lon=-93.2650,
                dropoff_city="Rochester",
                dropoff_lat=44.0121,
                dropoff_lon=-92.4802,
                cargo_type="Furniture",
                reward=2350.0,
                deadline_hours=8,
                urgency="standard",
            ),
            Job(
                company_id=company.id,
                pickup_city="Chicago",
                pickup_lat=41.8781,
                pickup_lon=-87.6298,
                dropoff_city="St. Louis",
                dropoff_lat=38.6270,
                dropoff_lon=-90.1994,
                cargo_type="Medical",
                reward=4200.0,
                deadline_hours=12,
                urgency="urgent",
            ),
        ]
        session.add_all(jobs)
        session.commit()
