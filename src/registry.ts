import { Ajv, type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { EventDefinition } from "./protocol.ts";

export interface DefinitionRevision {
  digest: string;
  definition: EventDefinition;
  inputSchema: object;
  outputSchema: object;
  instructions?: string;
  resolvedCommand?: string;
  validateInput(value: unknown): boolean;
  validateOutput(value: unknown): boolean;
}

export interface StoredDefinitionRevision {
  digest: string;
  definition: EventDefinition | string;
  inputSchema: object | string;
  outputSchema: object | string;
  instructions?: string | null;
  resolvedCommand?: string | null;
}

export class RegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

const EFFECT_POLICIES = new Set([
  "retry-safe",
  "idempotency-required",
  "manual-recovery",
]);

export function canonicalDigest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedValue(value));
}

function pathEscape(path: string): RegistryError {
  return new RegistryError("definition_path_escape", `definition path escapes project root: ${path}`);
}

function confinedRealpath(projectRoot: string, path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (error) {
    throw new RegistryError(
      "definition_invalid",
      `definition path cannot be resolved: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + sep)) throw pathEscape(path);
  return resolved;
}
function resolveReferencedPath(projectRoot: string, reference: string, baseDirectory?: string): string {
  if (isAbsolute(reference)) return confinedRealpath(projectRoot, reference);
  const localPath = join(baseDirectory ?? projectRoot, reference);
  try {
    return confinedRealpath(projectRoot, localPath);
  } catch (error) {
    if (baseDirectory == null || error instanceof RegistryError && error.code === "definition_path_escape") throw error;
    return confinedRealpath(projectRoot, join(projectRoot, reference));
  }
}


function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RegistryError(
      "definition_invalid",
      `invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RegistryError("definition_invalid", `${field} must be a non-empty string`);
  }
}

function validateDefinition(value: unknown, source: string): asserts value is EventDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryError("definition_invalid", `${source} must contain an object`);
  }
  const definition = value as Record<string, unknown>;
  requireString(definition.type, "type");
  if (!Number.isInteger(definition.version) || (definition.version as number) < 1) {
    throw new RegistryError("definition_invalid", "version must be a positive integer");
  }
  requireString(definition.inputSchema, "inputSchema");
  requireString(definition.outputSchema, "outputSchema");
  if (typeof definition.effectPolicy !== "string" || !EFFECT_POLICIES.has(definition.effectPolicy)) {
    throw new RegistryError("definition_invalid", "effectPolicy is invalid");
  }
  for (const field of ["timeoutMs", "hardDeadlineMs"]) {
    if (!Number.isSafeInteger(definition[field]) || (definition[field] as number) < 1) {
      throw new RegistryError("definition_invalid", `${field} must be a positive integer`);
    }
  }

  const retry = definition.retry;
  if (retry === null || typeof retry !== "object" || Array.isArray(retry)) {
    throw new RegistryError("definition_invalid", "retry must be an object");
  }
  const retryRecord = retry as Record<string, unknown>;
  if (!Number.isSafeInteger(retryRecord.maxAttempts) || (retryRecord.maxAttempts as number) < 1) {
    throw new RegistryError("definition_invalid", "retry.maxAttempts must be a positive integer");
  }
  if (
    !Array.isArray(retryRecord.backoffMs) ||
    retryRecord.backoffMs.some((entry) => !Number.isSafeInteger(entry) || (entry as number) < 0)
  ) {
    throw new RegistryError("definition_invalid", "retry.backoffMs must contain non-negative integers");
  }
  if (!Array.isArray(retryRecord.retryableCodes) || retryRecord.retryableCodes.some((entry) => typeof entry !== "string")) {
    throw new RegistryError("definition_invalid", "retry.retryableCodes must contain strings");
  }

  const requires = definition.requires;
  if (requires === null || typeof requires !== "object" || Array.isArray(requires)) {
    throw new RegistryError("definition_invalid", "requires must be an object");
  }
  const requiresRecord = requires as Record<string, unknown>;
  if (!Array.isArray(requiresRecord.tools) || requiresRecord.tools.some((entry) => typeof entry !== "string")) {
    throw new RegistryError("definition_invalid", "requires.tools must contain strings");
  }
  if (typeof requiresRecord.structuredOutput !== "boolean") {
    throw new RegistryError("definition_invalid", "requires.structuredOutput must be boolean");
  }
  for (const field of ["minContextTokens", "maxInputTokens", "maxOutputTokens", "maxPayloadBytes"]) {
    if (!Number.isSafeInteger(requiresRecord[field]) || (requiresRecord[field] as number) < 0) {
      throw new RegistryError("definition_invalid", `requires.${field} must be a non-negative integer`);
    }
  }

  const handler = definition.handler;
  if (handler === null || typeof handler !== "object" || Array.isArray(handler)) {
    throw new RegistryError("definition_invalid", "handler must be an object");
  }
  const handlerRecord = handler as Record<string, unknown>;
  if (handlerRecord.kind === "agent") {
    requireString(handlerRecord.instructions, "handler.instructions");
  } else if (handlerRecord.kind === "process") {
    requireString(handlerRecord.command, "handler.command");
    if (isAbsolute(handlerRecord.command)) throw pathEscape(handlerRecord.command);
    if (!Array.isArray(handlerRecord.args) || handlerRecord.args.some((entry) => typeof entry !== "string")) {
      throw new RegistryError("definition_invalid", "handler.args must contain strings");
    }
    if (!Array.isArray(handlerRecord.env) || handlerRecord.env.some((entry) => typeof entry !== "string")) {
      throw new RegistryError("definition_invalid", "handler.env must contain strings");
    }
  } else {
    throw new RegistryError("definition_invalid", "handler.kind is invalid");
  }
}

function jsonObject(value: object | string, field: string): object {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryError("definition_invalid", `${field} must be a JSON object`);
  }
  return parsed;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function compileRevision(record: StoredDefinitionRevision): DefinitionRevision {
  let definition: EventDefinition;
  try {
    definition = typeof record.definition === "string" ? JSON.parse(record.definition) : record.definition;
  } catch (error) {
    throw new RegistryError("definition_invalid", `invalid persisted definition: ${String(error)}`);
  }
  validateDefinition(definition, "stored definition");
  definition = sortedValue(definition) as EventDefinition;
  const inputSchema = jsonObject(record.inputSchema, "inputSchema");
  const outputSchema = jsonObject(record.outputSchema, "outputSchema");
  const ajv = new Ajv({ allErrors: true, strict: true });
  let inputValidator: ValidateFunction;
  let outputValidator: ValidateFunction;
  try {
    inputValidator = ajv.compile(inputSchema);
    outputValidator = ajv.compile(outputSchema);
  } catch (error) {
    throw new RegistryError("definition_invalid", `schema compilation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const revision: DefinitionRevision = {
    digest: record.digest,
    definition: freezeDeep(definition),
    inputSchema: freezeDeep(inputSchema),
    outputSchema: freezeDeep(outputSchema),
    ...(record.instructions == null ? {} : { instructions: record.instructions }),
    ...(record.resolvedCommand == null ? {} : { resolvedCommand: record.resolvedCommand }),
    validateInput(value: unknown): boolean {
      return inputValidator(value) as boolean;
    },
    validateOutput(value: unknown): boolean {
      return outputValidator(value) as boolean;
    },
  };
  return Object.freeze(revision);
}

function definitionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...definitionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

export class Registry {
  readonly #byKey: ReadonlyMap<string, DefinitionRevision>;
  readonly #all: readonly DefinitionRevision[];

  constructor(revisions: readonly DefinitionRevision[]) {
    this.#all = Object.freeze([...revisions]);
    this.#byKey = new Map(revisions.map((revision) => [`${revision.definition.type}\0${revision.definition.version}`, revision]));
  }

  resolve(type: string, version: number): DefinitionRevision {
    const revision = this.#byKey.get(`${type}\0${version}`);
    if (!revision) throw new RegistryError("definition_not_found", `definition not found: ${type}@${version}`);
    return revision;
  }

  revisions(): readonly DefinitionRevision[] {
    return this.#all;
  }
}

export function loadRegistry(projectRoot: string, definitionsDir: string, previous?: Registry): Registry {
  const root = realpathSync(projectRoot);
  const directory = confinedRealpath(root, isAbsolute(definitionsDir) ? definitionsDir : join(root, definitionsDir));
  const prior = new Map(previous?.revisions().map((revision) => [`${revision.definition.type}\0${revision.definition.version}`, revision]));
  const revisions: DefinitionRevision[] = [];
  const seen = new Set<string>();

  for (const file of definitionFiles(directory)) {
    const raw = parseJsonFile(file);
    validateDefinition(raw, file);
    const definition = raw;
    const key = `${definition.type}\0${definition.version}`;
    if (seen.has(key)) throw new RegistryError("definition_duplicate", `duplicate definition: ${definition.type}@${definition.version}`);
    seen.add(key);

    const inputPath = resolveReferencedPath(root, definition.inputSchema, directory);
    const outputPath = resolveReferencedPath(root, definition.outputSchema, directory);
    const inputBytes = readFileSync(inputPath);
    const outputBytes = readFileSync(outputPath);
    const inputSchema = parseJsonFile(inputPath);
    const outputSchema = parseJsonFile(outputPath);
    if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      throw new RegistryError("definition_invalid", `input schema must be an object: ${inputPath}`);
    }
    if (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema)) {
      throw new RegistryError("definition_invalid", `output schema must be an object: ${outputPath}`);
    }

    let instructions: string | undefined;
    let resolvedCommand: string | undefined;
    let instructionBytes = "";
    let commandBytes = "";
    if (definition.handler.kind === "agent") {
      const instructionPath = resolveReferencedPath(root, definition.handler.instructions, directory);
      instructionBytes = readFileSync(instructionPath).toString("utf8");
      instructions = instructionBytes;
    } else {
      const commandPath = resolveReferencedPath(root, definition.handler.command, directory);
      if (!statSync(commandPath).isFile()) throw new RegistryError("definition_invalid", `process command is not a file: ${commandPath}`);
      try {
        accessSync(commandPath, constants.X_OK);
      } catch {
        throw new RegistryError("definition_invalid", `process command is not executable: ${commandPath}`);
      }
      commandBytes = readFileSync(commandPath).toString("base64");
      resolvedCommand = commandPath;
    }

    const digest = canonicalDigest([
      canonicalJson(definition),
      inputBytes.toString("utf8"),
      outputBytes.toString("utf8"),
      instructionBytes,
      commandBytes,
    ]);
    const old = prior.get(key);
    if (old && old.digest !== digest) {
      throw new RegistryError("definition_version_required", `definition content changed; version must increase for ${definition.type}@${definition.version}`);
    }
    revisions.push(
      old && old.digest === digest
        ? old
        : compileRevision({ digest, definition: sortedValue(definition) as EventDefinition, inputSchema, outputSchema, instructions, resolvedCommand }),
    );
  }

  return new Registry(revisions);
}
