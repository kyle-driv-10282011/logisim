from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app
from app.models import Delivery


def test_health_endpoint() -> None:
    client = TestClient(app)
    response = client.get('/api/health')
    assert response.status_code == 200
    assert response.json()['status'] == 'ok'


def test_game_state_uses_seed_data() -> None:
    client = TestClient(app)
    response = client.get('/api/game-state')
    assert response.status_code == 200
    body = response.json()
    assert body['company']['name'] == 'Northstar Freight'
    assert body['fleet_count'] >= 1


def test_assign_job_creates_live_delivery() -> None:
    client = TestClient(app)
    response = client.post('/api/jobs/1/assign', json={'vehicle_id': 1})
    assert response.status_code == 200
    deliveries = client.get('/api/deliveries').json()
    assert len(deliveries) >= 1
    assert deliveries[0]['current_lat'] is not None
    assert deliveries[0]['current_lon'] is not None
    assert len(deliveries[0]['route']) >= 2


def test_seeded_state_starts_with_a_live_delivery() -> None:
    client = TestClient(app)
    deliveries = client.get('/api/deliveries').json()
    assert len(deliveries) >= 1
    assert deliveries[0]['eta'] is not None
    assert deliveries[0]['route']


def test_seeded_delivery_uses_a_multi_point_route() -> None:
    client = TestClient(app)
    deliveries = client.get('/api/deliveries').json()
    assert len(deliveries) >= 1
    assert len(deliveries[0]['route']) > 2


def test_delivery_eta_stays_visible_for_active_trips() -> None:
    client = TestClient(app)
    assign_response = client.post('/api/jobs/1/assign', json={'vehicle_id': 1})
    assert assign_response.status_code == 200

    with get_session() as session:
        delivery = session.query(Delivery).order_by(Delivery.id.desc()).first()
        assert delivery is not None
        delivery.started_at = datetime.now(timezone.utc) - timedelta(seconds=30)
        session.commit()
        delivery_id = delivery.id

    deliveries = client.get('/api/deliveries').json()
    matching_delivery = next(item for item in deliveries if item['id'] == delivery_id)
    assert matching_delivery['eta'] != '0s'
    assert matching_delivery['current_lat'] is not None
    assert matching_delivery['current_lon'] is not None
