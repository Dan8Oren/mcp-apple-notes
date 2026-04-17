import { pipeline } from "@huggingface/transformers";

console.log("Downloading model (first run may take a minute)...");
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const output = await extractor("test query", { pooling: "mean" });
console.log("OK - embedding dimensions:", output.data.length);
console.log("Sample values:", Array.from(output.data).slice(0, 5));
