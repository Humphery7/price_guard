import asyncio
import csv
import re
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

URL = "https://shop.manoapp.com/en/choose-country"
OUTPUT_FILE = "mano_products.csv"


# ─────────────────────────────────────────────
# STEP 1 – Location selection
# ─────────────────────────────────────────────
async def set_address(page):
    print("[1/4] Selecting location (Nigeria - Lagos)...")
    try:
        await page.wait_for_selector("div.countries-listing", timeout=10000)
        lagos = page.locator(
            "div.countries-listing div:has(h3:has-text('Nigeria - Lagos')) label.selection span.checkmark"
        )
        if await lagos.is_visible():
            await lagos.click()
            print("   Lagos selected.")
        await page.wait_for_timeout(1500)

        confirm = page.locator("div.buttons :has-text('Select Serviceable Area')").first
        await confirm.wait_for(state="visible", timeout=5000)
        await confirm.click()
        print("   ✅ 'Select Serviceable Area' clicked.")
    except PlaywrightTimeout:
        print("   ❌ Timeout on location selection.")
    except Exception as e:
        print(f"   ⚠️ Location error: {e}")

    await page.wait_for_timeout(3000)


# ─────────────────────────────────────────────
# STEP 2 – Extract product cards visible on page
# ─────────────────────────────────────────────
async def extract_card_data(card):
    name, price = "", ""
    try:
        infos = await card.query_selector("div.product-infos")
        if infos:
            price_el = await infos.query_selector("h2")
            if price_el:
                price = re.sub(r"[^\d]", "", await price_el.inner_text())
            name_el = await infos.query_selector("p")
            if name_el:
                name = (await name_el.inner_text()).strip()
    except Exception:
        pass
    return name, price


# ─────────────────────────────────────────────
# STEP 3 – Scroll a sub-category section fully
# ─────────────────────────────────────────────
async def scroll_and_collect(page, category_name, subcategory_name):
    """Scrolls until no new products appear, then harvests all product cards."""
    prev_count = 0
    no_change = 0

    for _ in range(60):
        await page.evaluate("""
            () => {
                const cards = document.querySelectorAll('div.product');
                if (cards.length > 0)
                    cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                else
                    window.scrollBy(0, 800);
            }
        """)
        await page.wait_for_timeout(1800)
        count = len(await page.query_selector_all("div.product"))
        if count == prev_count:
            no_change += 1
            if no_change >= 3:
                break
        else:
            no_change = 0
        prev_count = count

    cards = await page.query_selector_all("div.product")
    products, seen = [], set()
    for card in cards:
        name, price = await extract_card_data(card)
        if name and price:
            key = (category_name, subcategory_name, name)
            if key not in seen:
                seen.add(key)
                products.append({
                    "Category": category_name,
                    "Sub-Category": subcategory_name,
                    "Product Name": name,
                    "Price (₦)": price,
                })
    return products


# ─────────────────────────────────────────────
# STEP 4 – Collect ALL sub-category tabs
#           (including those hidden behind the > arrow)
# ─────────────────────────────────────────────
async def get_all_subtabs(page):
    """
    Collects sub-category tabs (e.g. EGGS, BUTTER, CHEESE) from inside a category page.
    These live in the scrollable tab bar within div.category-list-page (not the top nav).
    Clicks the right-arrow repeatedly to reveal hidden tabs.
    Returns list of (label, href) tuples.
    """
    seen_hrefs = set()
    tabs = []

    while True:
        # Sub-category tabs are inside the category page's own tab container
        # Selector targets the scrollable nav inside category-list-page
        tab_els = await page.query_selector_all(
            "div.category-list-page nav.scrollactive-nav a.v-tab, "
            "div.category-list-page div[class*='list-subs'] a.v-tab"
        )

        # Fallback: if the above finds nothing, the page may just have a flat list
        if not tab_els:
            break

        for el in tab_els:
            href = await el.get_attribute("href")
            text = (await el.inner_text()).strip()
            if href and href not in seen_hrefs:
                seen_hrefs.add(href)
                tabs.append((text, href))

        # Click the next-arrow inside the sub-tab slider (not the top nav arrow)
        arrow = page.locator(
            "div.category-list-page div.v-slide-group__next:not(.v-slide-group__next--disabled)"
        ).first
        if await arrow.count() == 0:
            break
        try:
            await arrow.click()
            await page.wait_for_timeout(800)
        except Exception:
            break

    return tabs


# ─────────────────────────────────────────────
# STEP 5 – Scrape one main category page
# ─────────────────────────────────────────────
async def scrape_category_page(page, category_name):
    """
    Called after navigating into a main category.
    Iterates every sub-category tab (including arrow-hidden ones).
    """
    all_products = []

    print(f"   Collecting sub-category tabs for '{category_name}'...")
    subtabs = await get_all_subtabs(page)
    print(f"   Found {len(subtabs)} sub-categories: {[t[0] for t in subtabs]}")

    for idx, (tab_label, tab_href) in enumerate(subtabs):
        full_url = f"https://shop.manoapp.com{tab_href}" if tab_href.startswith("/") else tab_href
        print(f"      [{idx+1}/{len(subtabs)}] Sub-cat: '{tab_label}' → {full_url}")

        try:
            # Always navigate directly by URL — avoids CSS apostrophe issues
            # and off-viewport click failures entirely
            await page.goto(full_url, wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(1500)

            # Wait for product grid
            try:
                await page.wait_for_selector("div.product", timeout=8000)
            except PlaywrightTimeout:
                print(f"         ⚠️ No products found for '{tab_label}', skipping.")
                continue

            prods = await scroll_and_collect(page, category_name, tab_label)
            print(f"         ✅ {len(prods)} products.")
            all_products.extend(prods)

        except Exception as e:
            print(f"         ⚠️ Error on sub-cat '{tab_label}': {e}")

    return all_products


# ─────────────────────────────────────────────
# STEP 6 – Main scrape loop over homepage grid
# ─────────────────────────────────────────────
async def scrape_all(page):
    all_products = []

    print("[3/4] Waiting for homepage category grid...")
    await page.wait_for_selector("div.categories-list a", timeout=15000)

    # Snapshot current URL (homepage) for back-navigation
    home_url = page.url

    # Grab all category links from the grid
    cat_els = await page.query_selector_all("div.categories-list a")
    categories = []
    for el in cat_els:
        href = await el.get_attribute("href")
        p_tag = await el.query_selector("p")
        label = (await p_tag.inner_text()).strip() if p_tag else href
        if href:
            categories.append((label, href))

    print(f"   Found {len(categories)} main categories.")

    for idx, (cat_label, cat_href) in enumerate(categories):
        print(f"\n[{idx+1}/{len(categories)}] → '{cat_label}'")
        full_url = f"https://shop.manoapp.com{cat_href}" if cat_href.startswith("/") else cat_href

        try:
            await page.goto(full_url, wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(2000)

      
            await scroll_and_collect(page, cat_label, "")

            sections = await page.query_selector_all("div.all-products > div[id]")

            if sections:
                prods = []

                for section in sections:
                    heading = await section.query_selector("h2")

                    if heading:
                        subcat = (await heading.inner_text()).strip()
                    else:
                        subcat = await section.get_attribute("id")

                    cards = await section.query_selector_all("div.product")

                    for card in cards:
                        name, price = await extract_card_data(card)

                        if name and price:
                            prods.append({
                                "Category": cat_label,
                                "Sub-Category": subcat,
                                "Product Name": name,
                                "Price (₦)": price,
                            })
            else:
                prods = await scroll_and_collect(page, cat_label, "")
                #stop

            print(f"   Subtotal for '{cat_label}': {len(prods)} products.")
            all_products.extend(prods)

        except Exception as e:
            print(f"   ⚠️ Failed to scrape '{cat_label}': {e}")

        # Return to homepage grid
        await page.goto(home_url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_selector("div.categories-list a", timeout=10000)
        await page.wait_for_timeout(1500)

    return all_products


# ─────────────────────────────────────────────
# STEP 7 – CSV writer
# ─────────────────────────────────────────────
def save_to_csv(products, filename):
    if not products:
        print("No products to save.")
        return
    fieldnames = ["Category", "Sub-Category", "Product Name", "Price (₦)"]
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(products)
    print(f"\n✅ Saved {len(products)} products → {filename}")


# ─────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────
async def main():
    async with async_playwright() as p:
        print("🚀 Launching browser...")
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        )
        page = await context.new_page()

        print(f"Navigating to {URL} ...")
        await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(2000)

        await set_address(page)

        print("[2/4] Waiting for store to load after location selection...")
        await page.wait_for_timeout(3000)

        all_products = await scrape_all(page)

        print(f"\n[4/4] Done. Total products scraped: {len(all_products)}")
        if all_products:
            print("\nSample (first 5):")
            for item in all_products[:5]:
                sc = f" / {item['Sub-Category']}" if item["Sub-Category"] else ""
                print(f"  [{item['Category']}{sc}] {item['Product Name']} — ₦{item['Price (₦)']}")

        await browser.close()

    save_to_csv(all_products, OUTPUT_FILE)


if __name__ == "__main__":
    asyncio.run(main())