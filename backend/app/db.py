from sqlalchemy.orm import Session

from .models import engine, init_db


def get_session() -> Session:
    return Session(engine)


def bootstrap_data() -> None:
    init_db()
