import { getTableColumns } from "drizzle-orm";
import { cascadeZonesTable } from "../src/schema/cascadeZones";

const cols = Object.keys(getTableColumns(cascadeZonesTable)).sort();
console.log("cascade_zones columns:", cols.join(", "));
console.log("wentRiskFree:", cols.includes("wentRiskFree"));
console.log("riskFreeSlExit:", cols.includes("riskFreeSlExit"));
