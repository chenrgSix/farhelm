import { readFileSync, readdirSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../../contracts/v1/", import.meta.url);
const base = "https://fleet.local/contracts/v1/";
// argv intentionally has one constrained executable followed by variable arguments.
const ajv = new Ajv({
  strict: true,
  strictTuples: false,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);
export const schemaFiles = Object.freeze(
  readdirSync(root)
    .filter((f) => f.endsWith(".schema.json"))
    .sort(),
);
for (const filename of schemaFiles)
  ajv.addSchema(JSON.parse(readFileSync(new URL(filename, root), "utf8")));
// Compile eagerly, so a broken or unresolved schema fails the suite at import time.
for (const filename of schemaFiles) ajv.getSchema(base + filename);

/** Accepts "task", "task.schema.json", or the schema's exact $id. */
export function getValidator(name) {
  const id = name.startsWith(base)
    ? name
    : base + (name.endsWith(".schema.json") ? name : name + ".schema.json");
  const validator = ajv.getSchema(id);
  if (!validator) throw new Error(`Unknown Fleet v1 schema: ${name}`);
  return validator;
}

/** Returns a boolean without modifying input. Error details are in validate.errors. */
export function validate(name, value) {
  const validator = getValidator(name);
  const valid = validator(value);
  validate.errors = validator.errors;
  return valid;
}
validate.errors = null;

/** Throws a readable Error on mismatch; returns the original value on success. */
export function assertValid(name, value) {
  const validator = getValidator(name);
  if (!validator(value))
    throw new Error(
      `Fleet v1 ${name} contract mismatch: ${ajv.errorsText(validator.errors, { separator: "; " })}`,
    );
  return value;
}
