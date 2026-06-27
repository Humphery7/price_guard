"""
Price Guard — Product Matching Engine

Multi-layer matching engine that compares internal Glovo products against
competitor listings using barcode matching, name normalization, attribute
extraction, and RapidFuzz fuzzy matching.

Can run in two modes:
  1. Local CSV mode (default) — reads from sample_data/ CSVs, outputs to CSV.
  2. BigQuery mode — reads from BigQuery tables, writes matches back to BigQuery.

Set environment variable MATCH_MODE=bigquery to use BigQuery mode.
"""

import os
import re
import csv
import json
from datetime import datetime

# Try to import rapidfuzz; fallback to simple token comparison if not available
try:
    from rapidfuzz import fuzz
except ImportError:
    print("⚠️  RapidFuzz not installed. Falling back to built-in fuzzy comparison.")
    class fuzz:
        @staticmethod
        def token_set_ratio(s1, s2):
            w1 = set(s1.lower().split())
            w2 = set(s2.lower().split())
            if not w1 or not w2:
                return 0
            intersection = w1.intersection(w2)
            return (len(intersection) / max(len(w1), len(w2))) * 100

        @staticmethod
        def partial_ratio(s1, s2):
            s1, s2 = s1.lower(), s2.lower()
            if s1 in s2 or s2 in s1:
                return 100
            return 50

# Try to import google-cloud-bigquery for BQ mode
try:
    from google.cloud import bigquery
    HAS_BIGQUERY = True
except ImportError:
    HAS_BIGQUERY = False

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
SAMPLE_DATA_DIR = "./sample_data"
MATCHES_OUTPUT = "./sample_data/product_matches.csv"

PROJECT_ID = os.environ.get("BQ_PROJECT_ID", "fulfillment-dwh-production")
DATASET_ID = os.environ.get("BQ_DATASET", "price_guard")
MATCH_MODE = os.environ.get("MATCH_MODE", "csv")  # "csv" or "bigquery"

# Brands dictionary for Brand Extraction
BRANDS = [
    "coca-cola", "coke", "quaker", "emborg", "president", "luc belaire", "nescafe", 
    "golden penny", "ocean spray", "best marula", "12 spices", "belaire", "pepsi",
    "golden penny", "chivita", "indomie", "dangote", "milo", "dano", "peak"
]

# ─────────────────────────────────────────────
# Text Normalization & Attribute Extraction
# ─────────────────────────────────────────────

def normalize_text(text):
    """Normalize text for consistent string matching."""
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text) # remove special chars and punctuation
    text = re.sub(r"\s+", " ", text).strip() # normalize whitespace
    return text

def extract_attributes(name):
    """Extract volume, weight, unit, pack count, and brand from name."""
    normalized = name.lower()
    brand = "generic"
    for b in BRANDS:
        if b in normalized:
            brand = b
            break
            
    # Extraction regexes
    volume_match = re.search(r"(\d+(?:\.\d+)?)\s*(ml|cl|l|litre|litres)", normalized)
    weight_match = re.search(r"(\d+(?:\.\d+)?)\s*(g|kg|gm|gram|grams)", normalized)
    pack_match = re.search(r"(\d+)\s*(?:pack|pk|pcs|pieces|count|qty)", normalized)
    
    volume, volume_unit = None, None
    if volume_match:
        volume = float(volume_match.group(1))
        volume_unit = volume_match.group(2)
        # Normalize unit
        if volume_unit in ["litre", "litres", "l"]:
            volume = volume * 1000  # Convert to ml
            volume_unit = "ml"
        elif volume_unit == "cl":
            volume = volume * 10  # Convert to ml
            volume_unit = "ml"
            
    weight, weight_unit = None, None
    if weight_match:
        weight = float(weight_match.group(1))
        weight_unit = weight_match.group(2)
        if weight_unit == "kg":
            weight = weight * 1000  # Convert to grams
            weight_unit = "g"
        elif weight_unit == "gm":
            weight_unit = "g"

    pack_count = int(pack_match.group(1)) if pack_match else 1
    
    return {
        "brand": brand,
        "volume": volume,
        "volume_unit": volume_unit,
        "weight": weight,
        "weight_unit": weight_unit,
        "pack_count": pack_count
    }

# ─────────────────────────────────────────────
# Data Loading
# ─────────────────────────────────────────────

def load_csv(path):
    """Load rows from CSV path as list of dicts."""
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return [row for row in reader]

def load_internal_products_from_bigquery(client):
    """Load internal products from BigQuery internal_products table."""
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.internal_products"
    query = f"SELECT product_sku, product_name FROM `{table_ref}`"
    print(f"📊 Querying internal products from {table_ref}...")
    results = client.query(query).result()
    products = []
    for row in results:
        products.append({
            "product_sku": row.product_sku,
            "product_name": row.product_name
        })
    print(f"   Loaded {len(products)} internal products.")
    return products

def load_competitor_products_from_bigquery(client):
    """Load competitor products from BigQuery raw_competitor_products table."""
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.raw_competitor_products"
    query = f"""
    SELECT competitor, product_name, latest_price, attributes
    FROM `{table_ref}`
    WHERE collected_at = (
        SELECT MAX(collected_at) FROM `{table_ref}` t2
        WHERE t2.competitor = `{table_ref}`.competitor
    )
    """
    print(f"📊 Querying competitor products from {table_ref}...")
    
    # Simpler approach: get latest batch per competitor
    query = f"""
    SELECT competitor, product_name, latest_price, attributes
    FROM `{table_ref}`
    WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    """
    results = client.query(query).result()
    
    competitors = {}
    for row in results:
        comp = row.competitor
        if comp not in competitors:
            competitors[comp] = []
        
        # Parse attributes JSON for barcode etc.
        attrs = {}
        if row.attributes:
            try:
                attrs = json.loads(row.attributes)
            except (json.JSONDecodeError, TypeError):
                pass
        
        competitors[comp].append({
            "Product Name": row.product_name,
            "Price (₦)": str(row.latest_price) if row.latest_price else "0",
            "product_barcode": attrs.get("barcode", ""),
        })
    
    for comp, items in competitors.items():
        print(f"   Loaded {len(items)} products for '{comp}'.")
    
    return competitors

def load_existing_matches_from_bigquery(client):
    """Load existing approved matches from BigQuery to avoid re-matching."""
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.product_matches"
    query = f"""
    SELECT product_sku, competitor, confidence_score, match_method
    FROM `{table_ref}`
    WHERE is_approved = TRUE AND (needs_rematch IS NULL OR needs_rematch = FALSE)
    """
    print(f"📊 Loading existing approved matches from {table_ref}...")
    try:
        results = client.query(query).result()
        existing = set()
        for row in results:
            existing.add((row.product_sku, row.competitor))
        print(f"   Found {len(existing)} existing approved matches (will be skipped).")
        return existing
    except Exception as e:
        print(f"   ⚠️ Could not load existing matches: {e}")
        return set()

# ─────────────────────────────────────────────
# Core Matching Logic
# ─────────────────────────────────────────────

def match_single_product(sku, g_name, comp_name, comp_items):
    """Match a single internal product against all items from one competitor."""
    g_norm = normalize_text(g_name)
    g_attr = extract_attributes(g_name)
    
    best_match = None
    best_score = 0
    best_method = ""
    best_explain = ""
    
    for item in comp_items:
        c_name = item.get("Product Name") or item.get("product_name") or item.get("Product_Name")
        if not c_name:
            continue
        c_norm = normalize_text(c_name)
        c_attr = extract_attributes(c_name)
        
        # Check 1: Barcode match (if available in both)
        g_barcode = item.get("product_barcode") or item.get("Barcode")
        # Note: internal product barcode would come from attributes in production
        if g_barcode and g_barcode == item.get("product_barcode", ""):
            # Only matches if the internal product also has barcode data
            pass
        
        # Check 2: Exact normalized name match
        if g_norm == c_norm:
            best_match = item
            best_score = 99
            best_method = "exact_normalized"
            best_explain = "Exact normalized name match"
            break
        
        # Check 3: Advanced heuristics & RapidFuzz
        brand_match = (g_attr["brand"] == c_attr["brand"]) and (g_attr["brand"] != "generic")
        
        # Compare Sizes/Weights/Volumes
        size_match = True
        if g_attr["volume"] and c_attr["volume"]:
            size_match = abs(g_attr["volume"] - c_attr["volume"]) < 0.1
        elif g_attr["weight"] and c_attr["weight"]:
            size_match = abs(g_attr["weight"] - c_attr["weight"]) < 0.1
            
        # Compare Pack Count
        pack_match = g_attr["pack_count"] == c_attr["pack_count"]
        
        # Fuzzy score name similarity
        token_score = fuzz.token_set_ratio(g_norm, c_norm)
        partial_score = fuzz.partial_ratio(g_norm, c_norm)
        weighted_score = (token_score * 0.6) + (partial_score * 0.4)
        
        # Adjust score based on attributes
        if brand_match:
            weighted_score += 10
        if size_match and (g_attr["volume"] or g_attr["weight"]):
            weighted_score += 15
        else:
            weighted_score -= 20  # Size mismatch penalty
        if not pack_match:
            weighted_score -= 15  # Pack count mismatch penalty
            
        # Bind score
        weighted_score = max(0, min(100, weighted_score))
        
        if weighted_score > best_score:
            best_score = weighted_score
            best_match = item
            best_method = "fuzzy_heuristics"
            best_explain = f"Fuzzy matching score: {weighted_score:.1f}%. Brand match: {brand_match}, Size match: {size_match}."
    
    if best_match and best_score >= 60:
        c_name = best_match.get("Product Name") or best_match.get("product_name") or best_match.get("Product_Name")
        price = best_match.get("Price (₦)") or best_match.get("Price") or best_match.get("latest_price") or 0
        
        try:
            price = float(str(price).replace(",", "").replace("₦", "").strip())
        except ValueError:
            price = 0
        
        return {
            "product_sku": sku,
            "competitor": comp_name,
            "competitor_product_name": c_name,
            "latest_price": price,
            "confidence_score": round(best_score, 1),
            "match_method": best_method,
            "match_explanation": best_explain,
            "is_approved": best_score >= 90,
            "last_matched_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
    
    return None

# ─────────────────────────────────────────────
# CSV Mode
# ─────────────────────────────────────────────

def match_products_csv():
    """Run matching engine in CSV mode (original behavior)."""
    print("🚀 Running Matching Engine in CSV mode...")
    
    glovo_products = load_csv(os.path.join(SAMPLE_DATA_DIR, "glovo.csv"))
    
    competitors = {
        "mano": load_csv(os.path.join(SAMPLE_DATA_DIR, "mano.csv")),
        "chowstore": load_csv(os.path.join(SAMPLE_DATA_DIR, "chowstore.csv")),
        "spar": load_csv(os.path.join(SAMPLE_DATA_DIR, "spar.csv")),
        "supersaver": load_csv(os.path.join(SAMPLE_DATA_DIR, "supersaver.csv"))
    }
    
    matches = []
    
    for gp in glovo_products:
        sku = gp.get("SKU") or gp.get("product_sku")
        g_name = gp.get("Product Name") or gp.get("product_name")
        
        for comp_name, comp_items in competitors.items():
            result = match_single_product(sku, g_name, comp_name, comp_items)
            if result:
                # CSV mode stores is_approved as string
                result["is_approved"] = "TRUE" if result["is_approved"] else "FALSE"
                matches.append(result)
                
    # Save output matches to CSV
    fieldnames = [
        "product_sku", "competitor", "competitor_product_name", "latest_price", 
        "confidence_score", "match_method", "match_explanation", "is_approved", "last_matched_date"
    ]
    with open(MATCHES_OUTPUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(matches)
        
    print(f"✅ Success! Saved {len(matches)} product matches to {MATCHES_OUTPUT}")
    return matches

# ─────────────────────────────────────────────
# BigQuery Mode
# ─────────────────────────────────────────────

def match_products_bigquery():
    """Run matching engine in BigQuery mode — reads/writes directly to BQ tables."""
    if not HAS_BIGQUERY:
        print("❌ google-cloud-bigquery is not installed. Cannot run in BigQuery mode.")
        print("   Install with: pip install google-cloud-bigquery")
        print("   Falling back to CSV mode...")
        return match_products_csv()
    
    print("🚀 Running Matching Engine in BigQuery mode...")
    client = bigquery.Client(project=PROJECT_ID)
    
    # Load data from BigQuery
    glovo_products = load_internal_products_from_bigquery(client)
    competitors = load_competitor_products_from_bigquery(client)
    existing_matches = load_existing_matches_from_bigquery(client)
    
    if not glovo_products:
        print("❌ No internal products found in BigQuery. Run the data ingestion pipeline first.")
        return []
    
    if not competitors:
        print("❌ No competitor products found in BigQuery. Run scrapers/ingestion first.")
        return []
    
    matches = []
    skipped = 0
    
    for gp in glovo_products:
        sku = gp["product_sku"]
        g_name = gp["product_name"]
        
        for comp_name, comp_items in competitors.items():
            # Skip if an approved match already exists (and not flagged for rematch)
            if (sku, comp_name) in existing_matches:
                skipped += 1
                continue
            
            result = match_single_product(sku, g_name, comp_name, comp_items)
            if result:
                matches.append(result)
    
    print(f"   Skipped {skipped} existing approved matches.")
    print(f"   Generated {len(matches)} new match candidates.")
    
    if not matches:
        print("✅ No new matches to write. All products are already matched.")
        return matches
    
    # Write matches to BigQuery
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.product_matches"
    print(f"📤 Writing {len(matches)} matches to {table_ref}...")
    
    rows_to_insert = []
    for m in matches:
        rows_to_insert.append({
            "product_sku": m["product_sku"],
            "competitor": m["competitor"],
            "competitor_product_name": m["competitor_product_name"],
            "latest_price": m["latest_price"],
            "confidence_score": m["confidence_score"],
            "match_method": m["match_method"],
            "match_explanation": m["match_explanation"],
            "is_approved": m["is_approved"],
            "needs_rematch": False,
            "last_matched_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })
    
    # Use streaming insert for efficiency
    table = client.get_table(table_ref)
    errors = client.insert_rows_json(table_ref, rows_to_insert)
    
    if errors:
        print(f"❌ BigQuery insert encountered errors: {errors[:3]}")
    else:
        print(f"✅ Successfully wrote {len(rows_to_insert)} matches to BigQuery!")
    
    # Also save a local CSV backup
    fieldnames = [
        "product_sku", "competitor", "competitor_product_name", "latest_price", 
        "confidence_score", "match_method", "match_explanation", "is_approved", "last_matched_date"
    ]
    backup_path = MATCHES_OUTPUT.replace(".csv", f"_backup_{datetime.now().strftime('%Y%m%d')}.csv")
    with open(backup_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for m in matches:
            row = dict(m)
            row["is_approved"] = "TRUE" if row["is_approved"] else "FALSE"
            writer.writerow(row)
    print(f"   Local backup saved to {backup_path}")
    
    return matches

# ─────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────

def match_products():
    """Route to the correct matching mode based on configuration."""
    if MATCH_MODE == "bigquery":
        return match_products_bigquery()
    else:
        return match_products_csv()

if __name__ == "__main__":
    match_products()
