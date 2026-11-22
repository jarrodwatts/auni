import {
  privateAcceptedWireSchema,
  privateCheckWireSchema,
  privateFieldWireSchema,
  type PrivateCheckWire,
  type PrivateFieldWire,
} from "@auni/shared";

import { requestCore } from "@/lib/core";

/**
 * A private field's calls: what it takes, what the typed values would do, taking them in, and
 * forgetting one. The values go to core's `/private/:id` and nowhere else; no answer carries
 * them back.
 */

type Values = Readonly<Record<string, string>>;

const path = (id: string, step = "") => `private/${encodeURIComponent(id)}${step}`;

/**
 * The field as core draws it. A CoreApiError `pair_again` says it takes proof the owner is there
 * that this browser can't give, before anything is typed; `unknown_field`, that core takes none
 * by this id now.
 */
export async function readPrivateField(id: string): Promise<PrivateFieldWire> {
  return privateFieldWireSchema.parse(await requestCore(path(id), { method: "GET" }));
}

export async function checkPrivate(id: string, values: Values): Promise<PrivateCheckWire> {
  return privateCheckWireSchema.parse(
    await requestCore(path(id, "/check"), { method: "POST", body: JSON.stringify({ values }) }),
  );
}

/** Takes the values in; what core says of how it took them, or null. */
export async function acceptPrivate(id: string, values: Values): Promise<string | null> {
  const { said } = privateAcceptedWireSchema.parse(
    await requestCore(path(id), { method: "POST", body: JSON.stringify({ values }) }),
  );
  return said;
}

/** Forgets what the field holds for one input, such as one of an app's keys. */
export async function clearPrivate(id: string, input: string): Promise<void> {
  await requestCore(path(id, "/clear"), { method: "POST", body: JSON.stringify({ input }) });
}

/** The inputs a field asks for: the ones it holds nothing for, or all of them to replace. */
export function askedInputs(field: PrivateFieldWire): PrivateFieldWire["inputs"] {
  const unset = field.inputs.filter(({ set }) => !set);
  return unset.length > 0 ? unset : field.inputs;
}
