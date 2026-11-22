import { specialistIdSchema } from "@auni/shared";
import { notFound } from "next/navigation";

import { SpecialistPlace } from "@/components/places/specialist-place";

export default async function SpecialistRoute({
  params,
}: {
  params: Promise<{ specialist: string }>;
}) {
  const parsed = specialistIdSchema.safeParse((await params).specialist);
  if (!parsed.success) notFound();

  return <SpecialistPlace key={parsed.data} specialistId={parsed.data} />;
}
