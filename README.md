# Base44 Local Converter

Move an app out of Base44 and run it on your own server.

You upload the ZIP exported from Base44. The converter analyzes it, converts what it safely can, and gives you back:

- a **self-hosted project** that runs with Docker, using **PostgreSQL** and **local file storage**
- a **migration report** that lists everything that still needs manual work

```
Base44 export ZIP ──► Converter ──► Self-hosted project (Docker)
                                          ├── PostgreSQL  (your data)
                                          └── /data/uploads (your files)
```

> **Nothing is deleted or silently changed.** Your original code is always kept untouched in the `original/` folder of the output.

---

## Contents

1. [Requirements](#1-requirements)
2. [Quick start](#2-quick-start-docker)
3. [Using the converter](#3-using-the-converter)
4. [Running your converted project](#4-running-your-converted-project)
5. [What gets converted (and what doesn't)](#5-what-gets-converted-and-what-doesnt)
6. [Configuration](#6-configuration)
7. [Development](#7-development)
8. [Command line (no UI)](#8-command-line-no-ui)
9. [API reference](#9-api-reference)
10. [Security](#10-security)
11. [Troubleshooting](#11-troubleshooting)
12. [Project layout](#12-project-layout)

---

## 1. Requirements

| To do this | You need |
|---|---|
| Run the converter (recommended) | Docker Desktop or Docker Engine, with Compose v2 |
| Develop or use the CLI | Node.js 22 or newer, plus a PostgreSQL database (the dev compose file provides one) |
| Run a converted project | Docker, or Node.js 20+ and PostgreSQL |

### Preparing an Ubuntu server (22.04 / 24.04)

Run these commands on the server (as a user with `sudo`). Skip any step you have already done.

**Step 1. Update the system and install basic tools.**

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git unzip
```

**Step 2. Install Docker Engine and the Compose plugin** (from Docker's official repository).

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**Step 3. Allow your user to run Docker without `sudo`.**

```bash
sudo usermod -aG docker $USER
```

Log out and log back in (or run `newgrp docker`) so the change takes effect.

**Step 4. Check that Docker works.**

```bash
docker --version
docker compose version
docker run --rm hello-world
```

**Step 5. Get the project onto the server.**

```bash
git clone <your-repository-url> base44-local-converter    # or upload the folder with scp / rsync
cd base44-local-converter
```

**Step 6. Open the firewall port** (only if `ufw` is enabled). Replace `4000` with your `APP_PORT`.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 4000/tcp
sudo ufw status
```

> The converter has no login. Don't open this port to the whole internet; restrict it to your IP
> (`sudo ufw allow from <your-ip> to any port 4000 proto tcp`) or put it behind an authenticating reverse proxy.

**Step 7. (Only for development or the CLI) Install Node.js 22.**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # should print v22.x
```

Then continue with the [Quick start](#2-quick-start-docker). The server is then reachable at `http://<server-ip>:4000`.

---

## 2. Quick start (Docker)

**Step 1.** Open a terminal in this folder.

**Step 2.** Create your settings file.

```bash
cp .env.example .env          # Windows (cmd): copy .env.example .env
```

**Step 3.** Open `.env` and change the password. This is the only required edit.

```ini
POSTGRES_PASSWORD=pick-a-strong-password
```

**Step 4.** Build and start.

```bash
docker compose up -d --build
```

The first build takes a few minutes.

**Step 5.** Open **http://localhost:4000** in your browser.

To stop it: `docker compose down`
To stop it **and delete all data**: `docker compose down -v`

---

## 3. Using the converter

1. **Export your app from Base44** as a ZIP file.
2. **Upload it.** Drag the ZIP onto the upload box, or click the box to choose a file.
3. **Watch the pipeline run.** Each stage shows its status and how long it took:

   | Stage | What it does |
   |---|---|
   | UPLOAD | Receives the file and records its checksum |
   | VALIDATE | Checks it is a safe, valid ZIP |
   | EXTRACT | Unpacks it safely |
   | ANALYZE | Detects the framework and Base44 usage |
   | PLAN | Builds the migration plan |
   | DATABASE | Generates PostgreSQL tables from your entities |
   | STORAGE | Generates local file storage |
   | TRANSFORM | Copies the original, then rewrites Base44 SDK imports in a working copy |
   | CONFIG | Generates Docker, compose and env files and the API server |
   | BUILD_VALIDATE | Checks the generated project |
   | PACKAGE | Creates the output ZIP |
   | REPORT | Writes the migration report |

4. **Read the "Needs manual migration" list.** These are things the converter could not do for you. Click **Show logs** if a stage fails.
5. **Download** the self-hosted project ZIP. Open `MIGRATION_REPORT.md` inside it first.

If a stage up to CONFIG fails, the remaining stages are skipped. If only BUILD_VALIDATE fails, the output is still packaged so you can inspect it.

---

## 4. Running your converted project

1. Unzip the downloaded file and open the folder.
2. Create the settings file and set a password:
   ```bash
   cp .env.example .env
   ```
   ```ini
   POSTGRES_PASSWORD=pick-a-strong-password
   ```
3. Start it:
   ```bash
   docker compose up -d --build
   ```
4. Open **http://localhost:3000** (change the port with `APP_PORT` in `.env`).

Uploaded files are kept in the `uploads` Docker volume (`/data/uploads` inside the container). Database data is kept in the `pgdata` volume.

**Inside the converted project**

| Folder / file | What it is |
|---|---|
| `original/` | Your untouched Base44 source |
| `app/` | The converted frontend |
| `server/` | The generated API (Fastify + PostgreSQL) |
| `MIGRATION_REPORT.md` / `.json` | What was done and what is left for you |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Deployment files |

---

## 5. What gets converted (and what doesn't)

### Converted automatically

| Base44 feature | Self-hosted result |
|---|---|
| Entity schemas (`entities/*.json`) | PostgreSQL tables (`schema.sql`) |
| `base44.entities.X.list / filter / get / create / bulkCreate / update / delete` | REST API with the same methods |
| `base44.integrations.Core.UploadFile` | Upload to local disk, served at `/uploads/...` |
| `base44.auth.me / isAuthenticated / logout` | A single local admin user |
| `import ... from '@base44/sdk'` | A local compatibility layer in `app/src/lib/local-base44/` |

### Needs manual work (always listed in the report)

| Item | Why |
|---|---|
| **Existing data** | A code export does not contain your records. Export them from Base44 and import into PostgreSQL. |
| **Real login / users** | The converted app has no authentication. |
| **Other integrations** (`InvokeLLM`, `SendEmail`, `GenerateImage`, ...) | No self-hosted equivalent. Calls throw a clear error until you implement them. |
| **Backend functions** (`functions/`), **agents** | Preserved but not converted. |
| **Other `@base44/*` packages** | Left in place and flagged. |
| **Hard-coded Base44 URLs** (images, files) | Files must be downloaded and re-hosted. |
| **Filter operators** (`$gt`, `$in`, ...) | The generated API supports equality filters only. |
| **Frameworks other than Vite, CRA or plain HTML** | A backend is generated, but you must build and serve the frontend yourself. |

If the converter can't determine something, it says so in the report and keeps the original code. It never guesses.

---

## 6. Configuration

Copy `.env.example` to `.env`. All values are optional except `POSTGRES_PASSWORD` for Docker.

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `converter` / *(required)* / `converter` | Database used by Docker Compose |
| `APP_PORT` | `4000` | Port the converter is published on |
| `DATABASE_URL` | local dev database | Connection string (non-Docker runs) |
| `PORT`, `HOST` | `4000`, `0.0.0.0` | API listen address |
| `DATA_DIR` | `/data` (Docker) | Base folder for all storage |
| `UPLOADS_DIR`, `PROJECTS_DIR`, `OUTPUT_DIR`, `LOGS_DIR`, `TEMP_DIR` | `DATA_DIR/<name>` | Override individual folders |
| `MAX_UPLOAD_MB` | `512` | Largest ZIP accepted |
| `MAX_UNCOMPRESSED_MB` | `2048` | Largest total size after unzipping |
| `MAX_ENTRIES` | `50000` | Most files allowed in one ZIP |
| `CONCURRENCY` | `1` | Conversions run at the same time |
| `VALIDATE_BUILD` | `false` | `true` also runs `npm install && npm run build` on the converted frontend (slow, needs internet) |

Storage layout:

```
/data/uploads    uploaded ZIPs
/data/projects   extracted source (read-only after extraction)
/data/output     generated projects, ZIPs and reports
/data/logs       per-job log files
/data/temp       upload temp files
```

---

## 7. Development

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL on localhost:5432
npm install
cp .env.example .env                             # defaults match the dev database
npm run dev:api                                  # terminal 1: http://localhost:4000
npm run dev:web                                  # terminal 2: http://localhost:5173
```

On Windows, set `DATA_DIR=./data` in `.env` (the default `/data` points to the drive root).

| Task | Command |
|---|---|
| Run tests | `npm test` |
| Type check | `npm run typecheck` |
| Production build | `npm run build` |
| Show container logs | `docker compose logs -f app` |

---

## 8. Command line (no UI)

Runs the full pipeline without PostgreSQL or the API:

```bash
npm run convert -- path/to/export.zip ./data
```

Output:

```
./data/output/<job-id>/project/                    the generated project
./data/output/<job-id>/self-hosted-project.zip     the same, zipped
```

---

## 9. API reference

Base URL: `http://localhost:4000`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/jobs` | Upload a ZIP (multipart field `file`). Returns `202` and the job. |
| `GET` | `/api/jobs` | List jobs |
| `GET` | `/api/jobs/:id` | Job details: stages, analysis, plan, findings |
| `GET` | `/api/jobs/:id/logs?stage=NAME` | Log lines, optionally for one stage |
| `GET` | `/api/jobs/:id/download` | The generated project ZIP |
| `GET` | `/api/jobs/:id/report?format=md\|json` | The migration report |
| `DELETE` | `/api/jobs/:id` | Delete the job and its files |

Example:

```bash
curl -F "file=@my-export.zip" http://localhost:4000/api/jobs
curl -OJ http://localhost:4000/api/jobs/<id>/download
```

---

## 10. Security

- **The converter has no login.** Run it on a trusted network or behind a reverse proxy that handles authentication.
- **Converted projects have no login either.** They use one local admin user. Add authentication before exposing them to the internet.
- **Uploads are never executed.** Extraction rejects path traversal (`../`), symlinks, encrypted entries, oversized archives and suspicious compression ratios (zip bombs).
- Set a strong `POSTGRES_PASSWORD` and never commit your `.env` file.

---

## 11. Troubleshooting

| Problem | What to do |
|---|---|
| `set POSTGRES_PASSWORD in .env` when starting | You skipped step 3 of the quick start. Add the password to `.env`. |
| Port already in use | Change `APP_PORT` in `.env`. |
| Upload rejected as too large | Raise `MAX_UPLOAD_MB` (and any proxy limit in front of the app). |
| `VALIDATE` stage fails | The file is not a valid ZIP, or it contains unsafe paths or exceeds a size limit. The error text says which. |
| `ANALYZE` finds no entities | The export has no `entities/*.json` files. Check the report; the data model must be defined manually. |
| Frontend not served after conversion | The framework isn't Vite, CRA or plain HTML. Build it yourself and put the output in `server/public`. |
| Converted app throws `[base44-local] ... not implemented` | That Base44 feature has no self-hosted version yet. See the report for where it is used. |
| Dates or numbers look wrong | Open an issue with the field type from your entity schema. |
| Windows: files go to the wrong drive | Set `DATA_DIR=./data` in `.env`. |
| Jobs stuck after a restart | They are marked failed automatically on startup. Upload again. |

---

## 12. Project layout

```
apps/
  web/              React + Vite user interface
  api/              Fastify API and job queue
packages/
  shared/           types, configuration, helpers
  extractor/        safe ZIP inspection and extraction
  analyzer/         framework and Base44 detection
  migration/        plan, database, storage, source, config, validation, packaging, report
  storage/          local filesystem layout
  database/         the converter's own PostgreSQL schema
  core/             pipeline runner
docker/             Dockerfile for the converter
scripts/            CLI
docs/               architecture notes
tests/              automated tests
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
