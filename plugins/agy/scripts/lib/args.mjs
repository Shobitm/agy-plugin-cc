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

// Slash commands pass "$ARGUMENTS" as one quoted string. Split it back into
// argv tokens, honouring simple single/double quoting.
export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;

  for (const ch of String(raw ?? "")) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
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

// A single argv element that contains whitespace and starts with a flag is a
// packed "$ARGUMENTS" string; anything else is already proper argv.
export function normalizeArgv(argv) {
  if (argv.length === 1 && /^\s*--/.test(argv[0]) && /\s/.test(argv[0].trim())) {
    return splitRawArgumentString(argv[0]);
  }
  if (argv.length === 1 && argv[0].trim() === "") {
    return [];
  }
  return argv;
}
