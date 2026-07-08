from __future__ import annotations

import os
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./logistics.db")

engine = create_engine(DATABASE_URL, future=True)


class Base(DeclarativeBase):
    pass


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    cash: Mapped[float] = mapped_column(Float, default=100000.0)
    reputation: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[int] = mapped_column(Integer, default=1)

    vehicles: Mapped[list["Vehicle"]] = relationship(back_populates="company", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="company", cascade="all, delete-orphan")
    deliveries: Mapped[list["Delivery"]] = relationship(back_populates="company", cascade="all, delete-orphan")


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    vehicle_type: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="idle")
    current_city: Mapped[str] = mapped_column(String(100), default="Minneapolis")
    fuel_level: Mapped[int] = mapped_column(Integer, default=100)
    current_lat: Mapped[float] = mapped_column(Float, default=44.9778)
    current_lon: Mapped[float] = mapped_column(Float, default=-93.2650)

    company: Mapped[Company] = relationship(back_populates="vehicles")
    deliveries: Mapped[list["Delivery"]] = relationship(back_populates="vehicle")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), nullable=False)
    pickup_city: Mapped[str] = mapped_column(String(100), nullable=False)
    pickup_lat: Mapped[float] = mapped_column(Float, nullable=False)
    pickup_lon: Mapped[float] = mapped_column(Float, nullable=False)
    dropoff_city: Mapped[str] = mapped_column(String(100), nullable=False)
    dropoff_lat: Mapped[float] = mapped_column(Float, nullable=False)
    dropoff_lon: Mapped[float] = mapped_column(Float, nullable=False)
    cargo_type: Mapped[str] = mapped_column(String(100), nullable=False)
    reward: Mapped[float] = mapped_column(Float, nullable=False)
    deadline_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    urgency: Mapped[str] = mapped_column(String(50), default="standard")
    status: Mapped[str] = mapped_column(String(50), default="available")

    company: Mapped[Company] = relationship(back_populates="jobs")
    deliveries: Mapped[list["Delivery"]] = relationship(back_populates="job")


class Delivery(Base):
    __tablename__ = "deliveries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), nullable=False)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="assigned")
    started_at: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), nullable=True)
    estimated_arrival: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), nullable=True)
    actual_arrival: Mapped[Optional[DateTime]] = mapped_column(DateTime(timezone=True), nullable=True)
    distance_km: Mapped[float] = mapped_column(Float, default=0.0)
    traffic_delay_minutes: Mapped[int] = mapped_column(Integer, default=0)
    route_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    company: Mapped[Company] = relationship(back_populates="deliveries")
    job: Mapped[Job] = relationship(back_populates="deliveries")
    vehicle: Mapped[Vehicle] = relationship(back_populates="deliveries")


def init_db() -> None:
    Base.metadata.create_all(engine)
