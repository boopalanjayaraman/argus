#!/bin/sh
# Orchestrator (8100) + three independent sub-agent services (8101-8103).
# Each sub-agent is its own process: kill/restart any one without touching the others.
cd "$(dirname "$0")/../src/services/inspection"
.venv/bin/python agent_service.py video 8101 &
.venv/bin/python agent_service.py image 8102 &
.venv/bin/python agent_service.py pointcloud 8103 &
AGENT_TRANSPORT=http CAD_REFERENCE_PLY="${CAD_REFERENCE_PLY:-}" .venv/bin/uvicorn app:app --port 8100 &
wait
