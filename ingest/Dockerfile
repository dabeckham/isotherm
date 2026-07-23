FROM python:3.12-slim

WORKDIR /app

# paho-mqtt<2 keeps the classic callback signature; psycopg2-binary talks to
# TimescaleDB (Postgres wire protocol).
RUN pip install --no-cache-dir "paho-mqtt<2" "psycopg2-binary>=2.9"

COPY bridge.py .

CMD ["python", "-u", "bridge.py"]
