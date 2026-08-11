# Boom competition platform adapters

Boom separates competition integration from solving into two host-owned capabilities:

1. **Challenge acquisition** lists challenges, obtains optional detail, downloads attachments, and
   materializes Boom's normal `<root>/challenges/<CATEGORY>/<slug>/` format.
2. **Flag submission** sends a candidate only after `ctf-submit` ends the solver turn, then maps the
   remote response to `accepted`, `rejected`, or `pending`.

The solver never receives the platform credential. Both the CLI runner and GUI runner load adapters
lazily from `<root>/platforms/<adapter-id>.json`; a challenge selects one through its host-owned
`meta.json`:

```json
{
  "category": "WEB",
  "difficulty": "Easy",
  "platform": {
    "adapter": "my-ctf",
    "challenge_id": "42",
    "options": { "game_id": "summer-2026" }
  }
}
```

## Generate from API documentation

The first importer accepts OpenAPI 3.x and Swagger 2.0 documents in JSON or YAML:

```sh
boom platform adapt \
  --id my-ctf \
  --document https://ctf.example/openapi.json \
  --root ./ctf
```

It identifies the challenge list, optional challenge detail, attachment fields, submission request,
authentication scheme, and verdict fields from paths and schemas. The command writes an auditable
declarative manifest, not executable generated code.

If inference leaves a required path/query/body variable or submission verdict unresolved, the
manifest status is `draft`. Boom refuses to execute drafts. Fill `variables`, correct the mappings,
and change the status to `ready` only after review. Use `--force` when intentionally regenerating an
existing manifest.

```sh
boom platform inspect --id my-ctf --root ./ctf
boom platform sync --id my-ctf --root ./ctf --var game_id=summer-2026
```

The desktop/browser workbench exposes the same lifecycle under **设置 → 比赛接口与自动同步**:

1. enter an adapter ID and OpenAPI/Swagger URL or local path;
2. generate and review the JSON manifest, including any inference warnings;
3. edit and save a draft after resolving its mappings;
4. enter non-secret `name=value` event variables and load the remote challenge catalog;
5. select individual challenges, select every item matching the active filters, or clear the selection;
6. synchronize only that selection. Challenge details and attachments are fetched at this point, not
   while browsing the catalog.

When the list or detail mapping exposes `category`, Boom normalizes common aliases (`web`, `rev`,
`re`, `crypto`, `steg`, and others) into its standard directory names. Missing or unknown values go
to `OTHER`; the original difficulty string is retained. The GUI groups its left challenge list by
the same category, and the solver turn receives category-specific triage context.

Boom disables platform generation, manifest changes, and synchronization while runs are active so
the challenge catalog cannot change underneath an existing batch. The panel shows the expected
credential environment variable and whether it was present when Boom started; it never displays the
credential value.

Values supplied through `--var` are non-secret competition context. They are persisted into each
downloaded challenge's platform options so later flag submission uses the same event/game context.
Adapters may also map non-secret per-challenge options from a catalog item. This is how a nested API
can retain a practice-ground ID alongside the remote challenge ID for later detail and submission calls.

## DASCTF practice profile

Use the official CTF2 User OpenAPI document rather than the signed-in developer dashboard page:

```text
https://ctf2.dasctf.com/api/openapi/v1/user.json
```

Recommended GUI values:

- Adapter ID: `dasctf`
- Name: `DASCTF 练习场`
- Base URL override: empty
- Credential environment variable: `BOOM_PLATFORM_DASCTF_TOKEN`
- PAT scopes: `practice:read`, `practice:submit`

The OpenAPI intentionally leaves practice response objects open-ended and does not expose a separate
challenge-list operation. Boom recognizes its stable operation IDs and creates the
`dasctf-practice-v1` profile. That profile reads the same-origin public practice catalog for paged,
searchable selection, while the following authenticated operations remain authoritative:

```text
GET  /api/open/v1/user/practice/{id}/challenges/{challengeId}/
POST /api/open/v1/user/practice/{id}/challenges/{challengeId}/submit/
```

The submit body contains the candidate plus DASCTF's required `confirmation: true`. A challenge's
`practice_ground_id` is stored in host-owned `meta.json`, never inferred again by the solver. The PAT
itself is never stored there. If DASCTF requires an interactive risk challenge for a submission, the
API error remains visible and Boom does not attempt to bypass it.

## Manifest shape

```json
{
  "version": 1,
  "id": "my-ctf",
  "name": "My CTF",
  "status": "ready",
  "baseURL": "https://ctf.example/api",
  "auth": {
    "env": "BOOM_PLATFORM_MY_CTF_TOKEN",
    "location": "header",
    "name": "Authorization",
    "prefix": "Bearer "
  },
  "variables": { "game_id": "summer-2026" },
  "operations": {
    "listChallenges": {
      "request": { "method": "GET", "path": "/games/{{variable.game_id}}/challenges" },
      "response": {
        "items": "data",
        "fields": {
          "id": "id",
          "slug": "slug",
          "title": "name",
          "description": "description",
          "category": "category",
          "difficulty": "difficulty"
        },
        "options": { "game_id": "game.id" }
      }
    },
    "getChallenge": {
      "request": { "method": "GET", "path": "/challenges/{{challenge.id}}" },
      "response": {
        "item": "data",
        "fields": {
          "id": "id",
          "title": "name",
          "description": "description",
          "category": "category",
          "difficulty": "difficulty"
        },
        "attachments": { "items": "files", "name": "name", "url": "url" }
      }
    },
    "submitFlag": {
      "request": {
        "method": "POST",
        "path": "/challenges/attempt",
        "body": { "challenge_id": "{{challenge.id}}", "submission": "{{flag}}" }
      },
      "response": {
        "verdict": "data.status",
        "detail": "data.message",
        "accepted": ["correct", "accepted"],
        "rejected": ["incorrect", "rejected"],
        "pending": ["pending", "queued"]
      }
    }
  }
}
```

Paths are dot-separated JSON field paths; `$` selects the current value. Templates support
`{{challenge.id}}`, `{{challenge.slug}}`, `{{flag}}`, and `{{variable.<name>}}`.

## Safety boundaries

- Credentials come only from the named environment variable. They are not accepted as CLI flags,
  embedded into generated manifests, copied into challenge directories, or exposed to the solver.
- API requests cannot leave the configured origin. Cross-origin attachment URLs are allowed, but
  Boom does not forward the platform credential to them.
- Responses and attachments have size limits; redirects are not followed; destination filenames and
  challenge slugs cannot escape the challenge root.
- Sync only updates a directory already owned by the same adapter and remote challenge ID. It refuses
  to overwrite an unrelated local challenge.
- An unknown submission response maps to `pending`, never to an assumed success.

OpenAPI inference is intentionally conservative. Human prose/PDF documentation and unusual
challenge flows can still be converted into the same manifest by an agent or by hand; supporting a
new platform should not require changing Boom's solver or task state machine.
