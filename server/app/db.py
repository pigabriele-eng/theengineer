import os
from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


def database_url(url: str) -> str:
    """Postgres URLs as Supabase and other hosts give them (postgres:// or postgresql://) use the psycopg 3
    driver; anything else is passed through."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url.removeprefix(prefix)
    return url


DATABASE_URL = database_url(os.environ.get("DATABASE_URL") or "sqlite:///./theengineer.db")

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # A long-lived server behind Supabase's pooler: a small pool, connections checked before use (the pooler
    # drops idle ones) and recycled now and then. Prepared statements are off so the transaction pooler
    # (port 6543) works as well as the session pooler.
    connect_args: dict = {"prepare_threshold": None}
    if ".supabase." in DATABASE_URL and "sslmode=" not in DATABASE_URL:
        connect_args["sslmode"] = "require"
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=300,
                           connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables() -> None:
    """Create the tables that don't exist yet (a column added or changed later needs a migration).

    On Postgres, row level security is switched on with no policies, so Supabase's Data API, which anyone with
    the app's public key can call, can't read or change them. The server connects as their owner and isn't
    affected.
    """
    Base.metadata.create_all(engine)
    # create_all makes a new table's indexes but not one added later to a table that exists: those are made here
    for t in Base.metadata.sorted_tables:
        for ix in t.indexes:
            ix.create(engine, checkfirst=True)
    if engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            for t in Base.metadata.sorted_tables:
                on = conn.execute(text("SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(:t)"),
                                  {"t": t.name}).scalar()
                if not on:
                    conn.execute(text(f'ALTER TABLE "{t.name}" ENABLE ROW LEVEL SECURITY'))
