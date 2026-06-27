# Price Guard – Pricing Intelligence & Competitive Monitoring Platform

Price Guard is a pricing intelligence platform that automatically monitors margins, detects competitor pricing gaps, flags supplier cost spikes, and highlights margin expansion opportunities. It runs every morning without manual intervention.

---

## How It Works

The system now uses a **single Google Sheet** as the source for all internal product data, eliminating the need for BigQuery. The daily pipeline reads from this sheet, processes competitor data from SPAR and SuperSaver sheets, and generates metrics and alerts.

Every morning at 8:00 AM, the system automatically:

1. **Pulls your internal product catalog** from the Glovo BigQuery data warehouse
2. **Reads SPAR & SuperSaver prices** from a Google Sheet linked to BigQuery
3. **Dispatches scrapers** (via GitHub Actions) to scrape Mano and Chowdeck prices
4. **Calculates all metrics** — margins, price index, revenue at risk, opportunity scores
5. **Detects pricing anomalies** — cost spikes, price spikes, competitor premiums
6. **Saves everything to BigQuery** so the dashboard loads instantly
7. **Emails you a daily alert summary** with critical pricing issues

You open the dashboard, and everything is already there. No manual queries, no exporting, no copy-pasting.

---

## Project Structure

```
├── .github/
│   └── workflows/
│       └── daily_pipeline.yml        # GitHub Actions: scrapers + upload + matching
├── candidate/
│   └── glovo.sql                     # Internal product catalog extraction query
├── competitors/
│   ├── queries/
│   │   ├── spar.sql                  # Normalize SPAR data from Connected Sheets
│   │   └── supersaver.sql            # Normalize SuperSaver data from Connected Sheets
│   └── scrapers/
│       ├── mano_scraper.py           # Playwright scraper for Mano App
│       └── chowstore_scraper.py      # Playwright scraper for Chowdeck
├── schemas/
│   ├── competitorproduct.ts          # TypeScript schema for competitor listings
│   └── glovo.ts                      # TypeScript schema for internal products
├── sample_data/
│   ├── glovo.csv                     # Sample internal product data
│   ├── mano.csv                      # Sample Mano competitor data
│   ├── chowstore.csv                 # Sample Chowdeck competitor data
│   ├── spar.csv                      # Sample SPAR competitor data
│   └── supersaver.csv                # Sample SuperSaver competitor data
├── src/
│   ├── UI/
│   │   └── index.html                # Dashboard frontend (Bootstrap 5 + Chart.js)
│   ├── Code.gs                       # Main entry point, pipeline orchestrator, triggers
│   ├── BigQueryService.gs            # Database abstraction (BigQuery / Spreadsheet / Mock)
│   ├── SchemaService.gs              # Auto-creates BigQuery tables on first run
│   ├── DataIngestionService.gs       # Automated data pull (Glovo, SPAR, SuperSaver, scrapers)
│   ├── MetricService.gs              # Core metric calculations with caching
│   ├── MetricSnapshotService.gs      # Precomputes & persists metrics to BigQuery
│   ├── AnomalyService.gs            # Anomaly detection & alert rules
│   ├── MatchingService.gs            # Product match management & approval
│   ├── MailService.gs                # HTML email alert digests
│   └── SettingsService.gs            # System thresholds & configuration
├── matching_engine.py                # Python matching engine (RapidFuzz + BigQuery)
├── upload_scraped_data.py            # Upload scraped CSVs to BigQuery
└── Readme.md                         # This file
```

---

## Step-by-Step Deployment Guide

Follow these phases in exact order. Nothing is skipped.

---

### Phase 1: Deploy the Web App (Instant — Works Immediately)

The web app runs in **Mock Mode** by default. You can explore the full dashboard with sample data before connecting any database.

**Step 1:** Open your browser and go to https://script.google.com.

**Step 2:** Click **New Project**. Name it `Price Guard Dashboard`.

**Step 3:** Delete the default `Code.gs` content. You will now create all the project files.

**Step 4:** Create the following **Script files** (`.gs`). For each one:
- Click the **+** button next to "Files" in the left sidebar.
- Select **Script**.
- Name it exactly as shown (without the `.gs` extension — Apps Script adds it automatically).
- Copy the contents from the corresponding file in the `src/` folder and paste it in.

Create these files in this order:

| File to create | Copy contents from |
|---|---|
| `Code` | `src/Code.gs` |
| `BigQueryService` | `src/BigQueryService.gs` |
| `SchemaService` | `src/SchemaService.gs` |
| `DataIngestionService` | `src/DataIngestionService.gs` |
| `MetricService` | `src/MetricService.gs` |
| `MetricSnapshotService` | `src/MetricSnapshotService.gs` |
| `AnomalyService` | `src/AnomalyService.gs` |
| `MatchingService` | `src/MatchingService.gs` |
| `MailService` | `src/MailService.gs` |
| `SettingsService` | `src/SettingsService.gs` |

**Step 5:** Create the HTML file for the dashboard:
- Click the **+** button next to "Files".
- Select **HTML**.
- In the name field, type `UI/index` (this creates the file as `UI/index.html`).
- Copy the contents from `src/UI/index.html` and paste it in.

**Step 6:** Deploy the web app:
- Click **Deploy** → **New Deployment** in the top-right.
- Click the gear icon next to "Select type" and choose **Web App**.
- Set **Execute as:** `Me`.
- Set **Who has access:** `Anyone` (or `Anyone within your organization`).
- Click **Deploy**.
- Authorize the permissions when prompted.
- Copy the **Web App URL** and open it in a new tab.

**You should now see the Price Guard dashboard running with mock sample data.**

---

### Phase 2: Enable BigQuery Advanced Service

Before connecting to BigQuery, you need to enable the BigQuery API in your Apps Script project.

**Step 1:** In your Apps Script project editor, click the **+** button next to **Services** in the left sidebar.

**Step 2:** Scroll down and find **BigQuery API**. Click it.

**Step 3:** Leave the version as `v2` and the identifier as `BigQuery`. Click **Add**.

**Step 4:** You should now see `BigQuery` listed under Services in the left sidebar.

---

### Phase 3: Set Up BigQuery (Google Cloud)

**Step 1:** Open the Google Cloud Console at https://console.cloud.google.com.

**Step 2:** Make sure you are in the correct Google Cloud project (check the project selector in the top bar).

**Step 3:** Search for **BigQuery** in the top search bar and open it.

**Step 4:** Note your **Project ID** from the project selector (e.g., `fulfillment-dwh-production`). You will need this.

> **Important:** You do NOT need to manually create any tables. The `SchemaService` will automatically create all required tables (`internal_products`, `raw_competitor_products`, `product_matches`, `computed_daily_metrics`, `daily_alerts`) the first time the pipeline runs. The dataset `price_guard` will also be created automatically if it doesn't exist.

---

### Phase 4: Connect SPAR & SuperSaver Partner Data (One-Time Setup)

SPAR and SuperSaver provide prices in Google Sheets. You link the sheet to BigQuery once, and it auto-reads fresh data every day.

**Step 1:** Create a Google Spreadsheet. Name it `Price Guard Partner Data`.

**Step 2:** Create a sheet tab named `SPAR`. Set the headers in Row 1 to:

```
Product_Name | latest_price | product_barcode | product_category_level_one | product_category_level_two | product_category_level_three | store_name
```

Paste your SPAR product pricing data below the headers.

**Step 3:** Create a second sheet tab named `SuperSaver`. Set the same headers:

```
Product_Name | latest_price | product_barcode | product_category_level_one | product_category_level_two | product_category_level_three | store_name
```

Paste your SuperSaver product pricing data below the headers.

**Step 4:** Link the SPAR sheet to BigQuery as an external table:
- Go to BigQuery Console.
- Under your project, find or create a dataset called `external_competitor_data`.
  - Click the three dots next to your project → **Create dataset**.
  - Dataset ID: `external_competitor_data`. Click **Create**.
- Click the three dots next to `external_competitor_data` → **Create table**.
- Set the following:
  - **Create table from:** `Drive`
  - **Select Drive URI:** Paste the full URL of your Google Spreadsheet.
  - **File format:** `Google Sheet`
  - **Sheet range:** `SPAR!A:G`
  - **Table name:** `spar_raw`
  - **Schema:** Check **Auto detect**.
- Click **Create Table**.

**Step 5:** Link the SuperSaver sheet to BigQuery:
- Repeat Step 4 with these differences:
  - **Sheet range:** `SuperSaver!A:G`
  - **Table name:** `supersaver_raw`
- Click **Create Table**.

**Done.** From now on, whenever you update the Google Sheet, the daily pipeline will automatically read the latest prices.

---

### Phase 5: Configure Script Properties (Switch to Live Mode)

**Step 1:** Go back to your Apps Script project editor.

**Step 2:** Click the **gear icon** (Project Settings) in the left sidebar.

**Step 3:** Scroll to the bottom and find **Script Properties**. Click **Edit script properties**.

**Step 4:** Add the following properties one by one:

| Property | Value | What It Does |
|---|---|---|
| `DB_MODE` | `bigquery` | Switches from mock data to live BigQuery |
| `BQ_PROJECT_ID` | Your GCP project ID (e.g., `fulfillment-dwh-production`) | Tells the app which GCP project to query |
| `BQ_DATASET` | `price_guard` | The BigQuery dataset for Price Guard tables |
| `BQ_EXTERNAL_DATASET` | `external_competitor_data` | The dataset containing SPAR/SuperSaver external tables |

**Step 5:** Click **Save script properties**.

---

### Phase 6: Install the Daily Trigger

**Step 1:** In the Apps Script editor, click on the **Select function** dropdown at the top (it should say `doGet` or something similar).

**Step 2:** Select `installDailyTrigger` from the dropdown.

**Step 3:** Click the **Run** button (▶).

**Step 4:** Authorize permissions when prompted. This creates a trigger that runs `scheduledDailyJobTrigger` every day at 8:00 AM.

**Step 5:** Verify the trigger was installed:
- Click the **clock icon** (Triggers) in the left sidebar.
- You should see a trigger for `scheduledDailyJobTrigger` set to run daily.

---

### Phase 7: Run the Pipeline for the First Time

**Step 1:** In the Apps Script editor, select `scheduledDailyJobTrigger` from the function dropdown.

**Step 2:** Click **Run** (▶).

**Step 3:** Click **View** → **Execution log** to watch the pipeline progress. You should see:

```
[Step 1/7] Ensuring BigQuery tables exist...
[Step 2/7] Refreshing internal product catalog...
[Step 3/7] Ingesting partner competitor data (SPAR, SuperSaver)...
[Step 4/7] Dispatching scraper pipeline (Mano, Chowdeck)...
[Step 5/7] Computing and persisting daily metrics...
[Step 6/7] Computing and persisting daily alerts...
[Step 7/7] Sending daily alert digest...
```

**Step 4:** Open your Web App URL. The dashboard should now show live data from BigQuery.

> **Note:** Step 4 (scraper dispatch) will show a warning if you haven't set up GitHub Actions yet. That's fine — SPAR and SuperSaver data will still work. Set up GitHub Actions in Phase 8 for Mano and Chowdeck automation.

---

### Phase 8: Set Up GitHub Actions for Scraper Automation (Optional)

This automates the Mano and Chowdeck scrapers so they run automatically every day and upload results to BigQuery.

**Step 1:** Push this project to a GitHub repository (or create a new one).

**Step 2:** Go to your repository on GitHub → **Settings** → **Secrets and variables** → **Actions**.

**Step 3:** Add the following repository secrets:

| Secret Name | Value |
|---|---|
| `BQ_PROJECT_ID` | Your GCP project ID (e.g., `fulfillment-dwh-production`) |
| `BQ_DATASET` | `price_guard` |
| `GCP_SERVICE_ACCOUNT_KEY` | The full JSON content of your GCP service account key file |

> To create a GCP service account key:
> 1. Go to Google Cloud Console → **IAM & Admin** → **Service Accounts**.
> 2. Create a new service account (or use an existing one).
> 3. Grant it the roles: **BigQuery Data Editor** and **BigQuery Job User**.
> 4. Click the service account → **Keys** → **Add Key** → **Create new key** → **JSON**.
> 5. Copy the entire contents of the downloaded JSON file.

**Step 4:** The workflow file is already at `.github/workflows/daily_pipeline.yml`. It will automatically run every day at 7:00 AM WAT (one hour before the GAS trigger).

**Step 5:** Connect the GAS app to dispatch scraper runs:
- Go back to your Apps Script **Script Properties** (Phase 5).
- Add two more properties:

| Property | Value |
|---|---|
| `SYSTEM_SETTINGS` | (leave blank — or configure via the Settings page in the web app) |

- Then open the Price Guard web app, go to **Settings**, and configure:
  - **GitHub PAT:** A GitHub Personal Access Token with `repo` scope.
  - **GitHub Repo:** `your-username/your-repo-name` (e.g., `mycompany/price-guard`)

---

### Phase 9: Run the Matching Engine (First Time)

The matching engine links your internal products to competitor products. It runs separately from the daily pipeline.

**Option A: Run Locally (Recommended for first setup)**

```bash
# Install dependencies
pip install rapidfuzz google-cloud-bigquery

# Run in CSV mode (uses sample_data/ files)
python matching_engine.py

# Or run in BigQuery mode (reads/writes from BigQuery)
set MATCH_MODE=bigquery
set BQ_PROJECT_ID=your-project-id
python matching_engine.py
```

**Option B: Run via GitHub Actions**

Go to your GitHub repository → **Actions** → **Price Guard Daily Pipeline** → **Run workflow** → Set "Also run the matching engine?" to `true` → Click **Run workflow**.

---

### Phase 10: Set Up Email Notifications

**Step 1:** Open the Price Guard web app.

**Step 2:** Go to the **Settings** page.

**Step 3:** Under **Notifications**, set:
- **Email Recipients:** The email address(es) to receive daily alerts (comma-separated).
- **Send Daily Summary:** Toggle to ON.

**Step 4:** Save settings.

The daily pipeline will now email a formatted HTML summary of all pricing anomalies every morning after the pipeline completes.

---

## What Runs Automatically Every Day

| Time (WAT) | What Happens | Where |
|---|---|---|
| 7:00 AM | Mano & Chowdeck scrapers run, upload to BigQuery | GitHub Actions |
| 8:00 AM | Full pipeline: pull catalog → ingest partners → compute metrics → detect alerts → email | Google Apps Script |

**You don't need to do anything.** Just open the dashboard whenever you need pricing intelligence.

---

## BigQuery Tables (Auto-Created)

| Table | Purpose |
|---|---|
| `price_guard.internal_products` | Your Glovo product catalog (refreshed daily) |
| `price_guard.raw_competitor_products` | All competitor price listings (SPAR, SuperSaver, Mano, Chowdeck) |
| `price_guard.product_matches` | Matched product pairs with confidence scores |
| `price_guard.computed_daily_metrics` | Precomputed dashboard metrics (one snapshot per day) |
| `price_guard.daily_alerts` | Precomputed pricing anomaly alerts |
| `external_competitor_data.spar_raw` | External table linked to SPAR Google Sheet tab |
| `external_competitor_data.supersaver_raw` | External table linked to SuperSaver Google Sheet tab |

---

## Script Properties Reference

| Property | Required | Default | Description |
|---|---|---|---|
| `DB_MODE` | Yes | `mock` | Set to `bigquery` for live mode |
| `BQ_PROJECT_ID` | Yes (for BQ mode) | — | Your Google Cloud Project ID |
| `BQ_DATASET` | No | `price_guard` | BigQuery dataset name |
| `BQ_EXTERNAL_DATASET` | No | `external_competitor_data` | Dataset for SPAR/SuperSaver external tables |

---

## Troubleshooting

**Dashboard shows mock/sample data:**
- Check Script Properties → `DB_MODE` should be `bigquery`.
- Check Script Properties → `BQ_PROJECT_ID` should be set.
- Run `scheduledDailyJobTrigger` manually and check the execution log.

**Tables not created:**
- Make sure the BigQuery Advanced Service is enabled (Phase 2).
- Run `scheduledDailyJobTrigger` — it calls `SchemaService.ensureTablesExist()` as Step 1.

**SPAR/SuperSaver data not appearing:**
- Check that the external tables (`spar_raw`, `supersaver_raw`) exist in BigQuery.
- Check that the Google Sheet has data below the header row.
- Check Script Properties → `BQ_EXTERNAL_DATASET` is correct.

**Scrapers not running:**
- Check GitHub Actions → look for failed workflow runs.
- Check that `GCP_SERVICE_ACCOUNT_KEY` secret is set correctly.
- Check that the service account has BigQuery permissions.

**Emails not sending:**
- Check Settings page → email recipients must be set.
- Check Settings page → "Send Daily Summary" must be ON.
- Run `scheduledDailyJobTrigger` manually and check the log for email errors.

**Daily trigger not firing:**
- Click the clock icon in Apps Script → verify the trigger exists.
- If missing, run `installDailyTrigger()` again.

---

## Adding a New Competitor

The system is designed to add new competitors with minimal changes:

1. **If the competitor has a Google Sheet:** Add a new tab to the Partner Data spreadsheet, create a BigQuery external table, and add a new SQL query in `DataIngestionService.gs`.

2. **If the competitor needs scraping:** Create a new scraper in `competitors/scrapers/`, add it to `upload_scraped_data.py`, and add it to the GitHub Actions workflow.

3. **Update Settings:** Add the new competitor name to the `competitors` section in `SettingsService.gs`.

No other files need to change. The matching engine, metric calculations, and dashboard will automatically pick up the new competitor's data.