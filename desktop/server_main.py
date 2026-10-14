"""The analysis server as the desktop app runs it: the same server as the online one (server/app), on this computer
only (127.0.0.1), with the database and the logs in the data folder the desktop app was given (main.js sets
DATABASE_URL, STORAGE_DIR and TE_PORT). PyInstaller makes it one program, so Python needn't be installed
(.github/workflows/desktop.yml)."""
import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TE_PORT", "8765")), log_level="warning")
