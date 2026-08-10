import { notFound } from "next/navigation";
import { ViewerGeometryHarness } from "./viewer-geometry-harness";

export default function ViewerGeometryPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <ViewerGeometryHarness />;
}
