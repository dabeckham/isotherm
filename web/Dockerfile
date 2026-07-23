FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir flask gunicorn "psycopg2-binary>=2.9" pyyaml

COPY app.py .
COPY static ./static

EXPOSE 8000
CMD ["gunicorn", "-b", "0.0.0.0:8000", "-w", "2", "--threads", "4", "app:app"]
