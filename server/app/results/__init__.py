"""Official series results: reading the series' result sheets, storing them and what they say about us."""
import importlib


def bind_models() -> None:
    """Put the results tables on the current database's metadata. The tests load a fresh app.db for every test;
    the server loads it once, so this does nothing there."""
    from app import db
    from app.results import models

    if models.Base is not db.Base:
        importlib.reload(models)
