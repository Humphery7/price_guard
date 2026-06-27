# Price Guard – Execution Scheduler Specification

The scheduling architecture separates daily pricing intelligence calculations from the periodic/on-demand execution of the product matching engine.

---

## 1. Daily Workflow (Runs every morning at 8:00 AM)

This pipeline updates the competitive pricing index, margin leakage metrics, and triggers alerts. It relies on previously established matches.

1. **Pull Internal Catalog:** Query BigQuery for updated internal product sales, costs, revenues, and categories (using `candidate/glovo.sql`).
2. **Execute Competitor Scrapers / Ingestion:**
   - Run Python web scrapers for Mano (`competitors/scrapers/mano_scraper.py`) and Chowdeck (`competitors/scrapers/chowstore_scraper.py`).
   - Query partner APIs/data dumps for SPAR (`competitors/queries/spar.sql`) and SuperSaver (`competitors/queries/supersaver.sql`).
   - Append raw listings directly to `raw_competitor_products` in BigQuery.
3. **Calculate Monitoring Metrics:**
   - Read active, approved competitor matches from the `product_matches` table.
   - Calculate price gaps, margin leakage, market median prices, and opportunity scores for the matched pairs.
4. **Execute Anomaly Detection & Scoring:**
   - Compare current pricing against historical averages and competitor prices using rules defined in `requirements/anomaly_rules.md`.
   - Calculate risk scores per product using formulas defined in `requirements/risk_score.md`.
5. **Update Dashboards & Notify:**
   - Write computed daily metrics and active alerts back to BigQuery tables.
   - Send consolidated daily alerts to pricing managers via Google Apps Script (using GmailApp).

---

## 2. Periodic/On-Demand Matching Workflow

The matching engine runs separately to reduce computational overhead, optimize API usage, and maintain a stable matching index.

### 2.1 Scheduled Triggers (Weekly)
* Runs every weekend at 12:00 AM.
* Scans for new, unmatched internal SKUs and new competitor products.
* Executes Layer 1 through Layer 8 matching as defined in `requirements/matching.md`.
* Appends new match candidates to the `product_matches` table.

### 2.2 On-Demand Event Triggers
* **Product Name/Barcode Change:** Automatically flags a product row in `product_matches` as `needs_rematch = TRUE` if the internal catalog metadata is updated.
* **Manual Trigger:** Triggers the matching runner for a specific SKU or a batch of products via the Apps Script "Match Management" interface (via GitHub repository dispatch).
