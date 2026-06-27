interface CompetitorProduct {
    competitor: string;
    product_name: string;
    latest_price: number;
    source_type: "scraper" | "partner";
    attributes?: Record<string, any>;
    collected_at: string;
}
export default CompetitorProduct;