import eslint from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

// Next's React, hooks, a11y and Core Web Vitals rules, scoped to the web app and the cards apps
// draw themselves, which the web app builds.
const WEB_FILES = ["apps/web/**/*.{js,jsx,mjs,ts,tsx}", "apps/core/src/apps/*/*.tsx"];
const webConfigs = nextVitals
  .filter((config) => config.files || config.rules)
  .map((config) => ({
    ...config,
    files: WEB_FILES,
    settings: {
      ...config.settings,
      next: { rootDir: "apps/web/" },
      react: { version: "19.3" },
    },
  }));

/**
 * Where a file may import from, read alike from an import, an `export ... from` and an `import()`:
 * ESLint's own no-restricted-imports reads only the first two, so an app's card could load its
 * app's server code with `import()`. An `import()` whose path is computed can't be checked, so
 * it is refused too. Each use gives `regex`, the paths it refuses, and the `message` that says why.
 */
const importPaths = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { regex: { type: "string" }, message: { type: "string" } },
        required: ["regex", "message"],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const [{ regex, message }] = context.options;
    const refused = new RegExp(regex, "u");
    const check = (node) => {
      const { source } = node;
      if (!source) return;
      const path =
        source.type === "Literal" && typeof source.value === "string"
          ? source.value
          : source.type === "TemplateLiteral" && source.expressions.length === 0
            ? source.quasis[0].value.cooked
            : null;
      if (path === null)
        context.report({
          node,
          message: "An import() names its path plainly, so it can be checked.",
        });
      else if (refused.test(path)) context.report({ node, message: `'${path}': ${message}` });
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

/**
 * What a person reads in Auni is plain words, and a card's words are data every channel draws
 * its own way. So nothing core, the web or shared writes joins two things with a middle dot or
 * an em dash: the words say how they belong together ("Opened a long on BTC", "From AI
 * buildout: 2x long"). Read from every string, template and line of JSX text; a comment may
 * hold one, and so may a test, which quotes what other services say.
 */
const SEPARATOR = String.raw`/[\u00b7\u2014]/`;
const plainWords = ["Literal[value=", "TemplateElement[value.raw=", "JSXText[value="].map(
  (node) => ({
    selector: `${node}${SEPARATOR}]`,
    message:
      "No middle dot or em dash in what a person reads: write the words so they stand without one.",
  }),
);

/**
 * A move's state changes only through `step` and `begins` in money/life.ts, so the whole of a
 * move's life reads in that one file. Anywhere else in core, a write to the actions table is
 * spelled out where it is made, so this rule can read every column it writes:
 *
 * - `update(actions)` and `insert(actions)` (or `schema.actions`) are called in one chain, and
 *   each `.set(...)`, `.values(...)` and `onConflictDoUpdate({ set })` in it is an object
 *   written out (or, for `values`, an array of them or a `.map` returning one).
 * - In those objects every key is plain (never computed), none is `status`, `phase`,
 *   `startedAt` or `endedAt`, an update's is never `details` (the card as it was shown), and nothing is
 *   spread but an insert's `...begins(state)`.
 * - No SQL text updates the actions table or inserts into it.
 *
 * It reads code as written: a table renamed through a variable is not followed. life.ts is
 * left out, since `step` writes what its own table of steps says.
 */
const MOVE_LIFE =
  "A move's state changes only in money/life.ts: take a step with step(), start a row with begins(), and leave its details as its card showed them. Anywhere else, write each column of the actions table out plainly.";
const WRITES_ACTIONS = /\b(update|insert\s+into)\s+"?actions"?(?![\w.])/iu;
const ENDS_IN_WRITE = /\b(update|insert\s+into)\s*"?$/iu;
const moveLife = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const refuse = (node) => context.report({ node, message: MOVE_LIFE });
    const isActions = (node) =>
      node?.type === "Identifier"
        ? node.name === "actions"
        : node?.type === "MemberExpression" && !node.computed && node.property.name === "actions";
    const keyOf = ({ key }) => (key.type === "Identifier" ? key.name : String(key.value));
    /** One row's columns: plain keys, none `refused`, and no spread but `begins(...)` where allowed. */
    const columns = (node, refused, begins) => {
      if (node?.type !== "ObjectExpression") return refuse(node ?? context.sourceCode.ast);
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const { argument } = property;
          const spreadsBegins =
            argument.type === "CallExpression" &&
            argument.callee.type === "Identifier" &&
            argument.callee.name === "begins";
          if (!(begins && spreadsBegins)) refuse(property);
        } else if (property.computed || refused.includes(keyOf(property))) refuse(property);
      }
    };
    const UPDATE = ["status", "phase", "startedAt", "endedAt", "details"];
    const INSERT = ["status", "phase", "startedAt", "endedAt"];
    /** An insert's rows: one object, an array of them, or `.map(...)` to one. */
    const rows = (node) => {
      if (node?.type === "ArrayExpression") return node.elements.forEach(rows);
      if (
        node?.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.name === "map" &&
        node.arguments[0]?.type === "ArrowFunctionExpression" &&
        node.arguments[0].body.type !== "BlockStatement"
      )
        return columns(node.arguments[0].body, INSERT, true);
      return columns(node, INSERT, true);
    };
    const conflictSet = (node) => {
      if (node?.type !== "ObjectExpression") return refuse(node ?? context.sourceCode.ast);
      const set = node.properties.find(
        (property) => property.type === "Property" && keyOf(property) === "set",
      );
      if (node.properties.some((property) => property.type === "SpreadElement")) refuse(node);
      if (set) columns(set.value, UPDATE, false);
    };
    return {
      CallExpression(call) {
        const { callee } = call;
        if (callee.type !== "MemberExpression" || !isActions(call.arguments[0])) return;
        const verb = callee.computed ? null : callee.property.name;
        if (verb !== "update" && verb !== "insert") return;
        // Each method called on it in turn, so a write held in a variable can't go unread.
        let link = call;
        if (link.parent.type !== "MemberExpression") return refuse(call);
        while (
          link.parent.type === "MemberExpression" &&
          link.parent.parent.type === "CallExpression"
        ) {
          const method = link.parent;
          const next = link.parent.parent;
          if (method.computed) refuse(method);
          const name = method.property.name;
          if (name === "set") columns(next.arguments[0], UPDATE, false);
          else if (name === "values") rows(next.arguments[0]);
          else if (name === "onConflictDoUpdate") conflictSet(next.arguments[0]);
          link = next;
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && WRITES_ACTIONS.test(node.value)) refuse(node);
      },
      TemplateLiteral(node) {
        node.quasis.forEach((quasi, index) => {
          const text = quasi.value.cooked ?? quasi.value.raw;
          if (WRITES_ACTIONS.test(text)) refuse(quasi);
          else if (ENDS_IN_WRITE.test(text) && isActions(node.expressions[index])) refuse(quasi);
        });
      },
    };
  },
};
const auni = { rules: { "import-paths": importPaths, "move-life": moveLife } };

/** The rule that holds a boundary: files matching it import nothing `regex` matches. */
const importsOnly = (regex, message) => ({
  plugins: { auni },
  rules: { "auni/import-paths": ["error", { regex, message }] },
});

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      // Auni's primitives with the vendored shadcn/ui parts they're built on, and AI Elements
      // sources, owned upstream: reviewed on add rather than linted to project rules.
      "apps/web/components/ui/**",
      "apps/web/components/ai-elements/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...webConfigs,
  {
    // A forgotten await on a send or a record is a money bug; these rules need type info.
    files: ["apps/core/src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // An app reaches core (../../) and the contract (../contract.ts), never another app.
    files: ["apps/core/src/apps/*/**"],
    ...importsOnly(
      String.raw`^\.\./(?!\.\./|contract\.ts$)`,
      "An app imports core (../../) and ../contract.ts, never another app or the registry.",
    ),
  },
  {
    // Core reaches the apps through apps/registry.ts, and their contract in contract.ts.
    files: ["apps/core/src/**/*.ts"],
    ignores: ["apps/core/src/apps/**"],
    ...importsOnly(
      String.raw`(^|/)apps/(?!registry\.ts$|contract\.ts$)[^/]+/`,
      "Core reaches an app through apps/registry.ts.",
    ),
  },
  {
    // An app's own card only draws what it is handed. It reaches React, @auni/shared, the web's
    // components and helpers, and its own folder's views and schemas: never the web's data layer
    // or core (it can't fetch or act), and never its app's other code, which may read keys that
    // would then ship to the browser.
    files: ["apps/core/src/apps/*/*.tsx"],
    ...importsOnly(
      String.raw`^(?!(react|@auni/shared)$|@/components/|@/lib/(?!data/|core\b)|\./[\w-]+(\.card)?\.tsx$|\./[\w-]+\.schema\.ts$)`,
      "An app's card imports react, @auni/shared, the web's @/components and @/lib (not @/lib/data or @/lib/core), and its folder's .tsx and .schema.ts files only.",
    ),
  },
  {
    // What an app's card is handed is plain data, read by core and the web alike.
    files: ["apps/core/src/apps/*/*.schema.ts"],
    ...importsOnly(
      String.raw`^(?!(zod|@auni/shared)$)`,
      "A card's schema imports zod and @auni/shared only.",
    ),
  },
  {
    files: ["apps/core/src/**/*.{ts,tsx}", "apps/web/**/*.{ts,tsx}", "packages/shared/src/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...plainWords] },
  },
  {
    files: ["apps/core/src/**/*.ts"],
    ignores: ["**/*.test.ts", "apps/core/src/test/**", "apps/core/src/money/life.ts"],
    plugins: { auni },
    rules: { "auni/move-life": "error" },
  },
  {
    rules: {
      // A handler's leading arguments it doesn't read, like Express's req, are named _req.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
