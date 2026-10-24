export function parseCommandInput(rawArgv, options = {}) {
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const aliasMap = options.aliases ?? {};
  const parsedOptions = {};
  const positionals = [];

  for (let index = 0; index < rawArgv.length; index += 1) {
    const token = rawArgv[index];
    if (token === "--") {
      positionals.push(...rawArgv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const eqIndex = token.indexOf("=");
    const rawName = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    const inlineValue = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;
    const normalizedName =
      aliasMap[rawName] ?? rawName.replace(/^-+/, "").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

    if (booleanFlags.has(normalizedName)) {
      parsedOptions[normalizedName] = inlineValue == null ? true : inlineValue !== "false";
      continue;
    }

    if (valueFlags.has(normalizedName)) {
      const nextValue = inlineValue ?? rawArgv[index + 1];
      if (nextValue == null) {
        throw new Error(`Missing value for ${rawName}`);
      }
      if (inlineValue == null) {
        index += 1;
      }
      parsedOptions[normalizedName] = nextValue;
      continue;
    }

    throw new Error(`Unknown option: ${rawName}`);
  }

  return { options: parsedOptions, positionals };
}

// Slash commands hand "$ARGUMENTS" over as one string. Split it back into
// argv tokens. A quote only opens at the start of a token, so apostrophes in
// prose ("don't") stay literal, and a backslash escapes the next character.
export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;
  const chars = [...String(raw ?? "")];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < chars.length) {
        current += chars[(i += 1)];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < chars.length) {
      current += chars[(i += 1)];
      hasToken = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !hasToken) {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

// `alwaysSplit` is for subcommands that take no free text (status, result,
// cancel, setup): a single argv element is always a packed "$ARGUMENTS".
// Free-text subcommands only unpack a single element that starts with a flag,
// so a prompt passed as one proper argv element is left intact.
export function normalizeArgv(argv, { alwaysSplit = false } = {}) {
  if (argv.length !== 1) {
    return argv;
  }
  const [only] = argv;
  if (only.trim() === "") {
    return [];
  }
  if (alwaysSplit || (/^\s*--/.test(only) && /\s/.test(only.trim()))) {
    return splitRawArgumentString(only);
  }
  return argv;
}
