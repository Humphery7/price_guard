import os
import csv
import json
from datetime import datetime
from google.cloud import bigquery

# Table ID configuration
PROJECT_ID = os.environ.get("BQ_PROJECT_ID", "fulfillment-dwh-production")
DATASET_ID = "price_guard"
TABLE_REF = f"{PROJECT_ID}.{DATASET_ID}.raw_competitor_products"

def clean_price(price_str):
    """Clean currency symbol and comma format from price strings."""
    try:
        return float(str(price_str).replace("₦", "").replace(",", "").strip())
    except ValueError:
        return 0.0

def upload_scraped_csv(csv_path, competitor):
    """Reads a local scraper CSV and appends records to the central BigQuery table."""
    if not os.path.exists(csv_path):
        print(f"⚠️ File {csv_path} not found. Skipping upload for {competitor}.")
        return

    print(f"🚀 Reading scraped listings from {csv_path}...")
    client = bigquery.Client(project=PROJECT_ID)

    rows_to_insert = []
    collected_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            product_name = row.get("Product Name") or row.get("product_name")
            raw_price = row.get("Price (₦)") or row.get("Price") or row.get("price") or 0
            
            # Attributes JSON block
            attributes = {
                "category": row.get("Category", ""),
                "subcategory": row.get("Sub-Category", "")
            }
            
            if "Barcode" in row:
                attributes["barcode"] = row["Barcode"]

            rows_to_insert.append({
                "competitor": competitor,
                "product_name": product_name,
                "latest_price": clean_price(raw_price),
                "source_type": "scraper",
                "attributes": json.dumps(attributes),
                "collected_at": collected_at
            })

    if not rows_to_insert:
        print(f"No products found in {csv_path}.")
        return

    print(f"Uploading {len(rows_to_insert)} records for '{competitor}' into BigQuery table '{TABLE_REF}'...")
    
    # Configure BigQuery load settings
    job_config = bigquery.LoadJobConfig(
        schema=[
            bigquery.SchemaField("competitor", "STRING"),
            bigquery.SchemaField("product_name", "STRING"),
            bigquery.SchemaField("latest_price", "NUMERIC"),
            bigquery.SchemaField("source_type", "STRING"),
            bigquery.SchemaField("attributes", "STRING"),
            bigquery.SchemaField("collected_at", "TIMESTAMP"),
        ],
        write_disposition="WRITE_APPEND",
    )

    try:
        job = client.load_table_from_json(rows_to_insert, TABLE_REF, job_config=job_config)
        job.result()  # Wait for upload to complete
        print(f"✅ Successfully uploaded '{competitor}' data to BigQuery!")
    except Exception as e:
        print(f"❌ Failed to upload data to BigQuery: {e}")

def execute_sql_query(query_path, dest_table=None):
    """Executes a local SQL query script in BigQuery, optionally writing to a destination table."""
    if not os.path.exists(query_path):
        print(f"⚠️ Query script {query_path} not found. Skipping execution.")
        return

    print(f"🚀 Reading query script from {query_path}...")
    client = bigquery.Client(project=PROJECT_ID)

    with open(query_path, "r", encoding="utf-8") as f:
        sql = f.read()

    job_config = None
    if dest_table:
        job_config = bigquery.QueryJobConfig(
            destination=dest_table,
            write_disposition="WRITE_TRUNCATE"  # Overwrite catalog table on daily refresh
        )

    try:
        query_job = client.query(sql, job_config=job_config)
        query_job.result()  # Wait for query to complete
        print(f"✅ Successfully executed query {query_path}!")
    except Exception as e:
        print(f"❌ SQL Execution failed for {query_path}: {e}")

if __name__ == "__main__":
    # 1. Update the internal catalog table automatically using candidate/glovo.sql
    internal_dest = f"{PROJECT_ID}.{DATASET_ID}.internal_products"
    execute_sql_query("./candidate/glovo.sql", dest_table=internal_dest)

    # 2. Upload scraped competitor data (Mano & Chowdeck)
    upload_scraped_csv("mano_products.csv", "mano")
    upload_scraped_csv("./sample_data/chowstore.csv", "chowstore")

    # 3. Standardize and copy sheets partner data (SPAR & SuperSaver) from external tables
    execute_sql_query("./competitors/queries/spar.sql")
    execute_sql_query("./competitors/queries/supersaver.sql")
    
    print("\n🎉 BigQuery daily synchronization completed successfully!")
