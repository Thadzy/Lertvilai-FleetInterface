FROM pgrouting/pgrouting:15-3.5-3.5.0

# This Dockerfile sets up a PostgreSQL instance with pgRouting pre-installed.
# It automatically initializes the database schema from graph.sql.

# Copy the merged SQL file to the initialization directory
# Files in this directory are executed in alphabetical order when the container starts for the first time.
COPY graph.sql /docker-entrypoint-initdb.d/10-graph.sql

# Expose the default PostgreSQL port
EXPOSE 5432
