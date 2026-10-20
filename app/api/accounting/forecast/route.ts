import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { getWorkspaceForecast } from "@/lib/accounting/server";

/**
 * Cash forecast from confirmed commitments.
 *
 * The response is a discriminated union: a caller must handle `possible: false`
 * and render the reason rather than an empty projection. Returning zeroed
 * horizons would let a flat line be read as a forecast.
 */
export async function GET(request: Request) {
  // The forecast date is a parameter of the calculation, so it is resolved once
  // here and passed down rather than read inside the pure module. That keeps
  // buildCashForecast deterministic and testable.
  const requested = new URL(request.url).searchParams.get("today");
  const today = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);

  try {
    return NextResponse.json(await getWorkspaceForecast(today));
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.forecast.get_failed", error, { message: "Unable to build the forecast." });
  }
}
