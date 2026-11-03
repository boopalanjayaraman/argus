"""Google Cloud Logging for the inspection service and its sub-agents.

Enabled when GCP_PROJECT_ID is set (see .env.example; authorisation via
GOOGLE_APPLICATION_CREDENTIALS or ADC/workload identity on GCP). Without a
project id, entries print as structured JSON lines locally — same shape,
same labels (service, sessionId) as the Node API logger, so one inspection
traces across services in Cloud Logging. Never logs media bytes or secrets.
"""
from __future__ import annotations
import json
import os
import time

PROJECT = os.environ.get("GCP_PROJECT_ID") or ""
LOG_NAME = os.environ.get("GCP_LOG_NAME", "argus")
_client = None
_logger = None


def _init():
    global _client, _logger
    if _logger is not None or not PROJECT:
        return _logger
    try:
        import google.cloud.logging as gcl
        _client = gcl.Client(project=PROJECT)
        _client.setup_logging()
        _logger = _client.logger(LOG_NAME)
    except Exception as exc:  # fall back to stdout, never crash the service
        print(json.dumps({"severity": "ERROR", "message": f"cloud logging init failed: {exc}", "service": "argus-inspection"}))
        _logger = False
    return _logger


def log(severity: str, message: str, service: str = "argus-inspection", **fields) -> None:
    entry = {"severity": severity, "message": message, "service": service, "time": time.time(), **fields}
    logger = _init()
    if logger:
        labels = {"service": service}
        if fields.get("sessionId"):
            labels["sessionId"] = str(fields["sessionId"])
        try:
            logger.log_struct(entry, severity=severity, labels=labels)
            return
        except Exception:
            pass
    print(json.dumps(entry), flush=True)


def info(message: str, service: str = "argus-inspection", **fields) -> None:
    log("INFO", message, service, **fields)


def warning(message: str, service: str = "argus-inspection", **fields) -> None:
    log("WARNING", message, service, **fields)


def error(message: str, service: str = "argus-inspection", **fields) -> None:
    log("ERROR", message, service, **fields)
