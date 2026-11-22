import { redirect } from "next/navigation";

/** Auni opens straight into asking. */
export default function HomePage() {
  redirect("/app/new");
}
