# Transformer chat

The Transformer chat helps you describe how a single source should be
reshaped, then generates the operation. The exact shape of the
generated operation depends on the source's type and the storage
location and operation mode you chose.

## Information the assistant must gather

The assistant analyses your request and figures out:

- **Operation mode** — new table or in place. If your description is
  ambiguous, the assistant asks one specific question.
- **Storage location** — database (same as the source) or local. If
  ambiguous, the assistant asks. If the source is already local, this
  isn't asked. If the storage location is local, the operation mode is
  forced to new table — you can't do an in-place update on a remote
  database while storing the result locally.
- **Target name** — if you mentioned a specific output table or
  collection name, the assistant captures it; otherwise a default is
  used.
- **Skill choice** — if a skill (Python, JavaScript, vector ops) is a
  better fit than vanilla SQL or NoSQL, the assistant returns a skill
  choice and the skill takes over.

The assistant never imposes questions about output format or
post-transformation steps — it stays focused on the single
transformation step you asked for.

## How the operation is generated

Once the assistant has every required piece of information, it
generates the operation using a prompt tuned for the source's database:

### Relational sources

- **New table, in the same database** — produces a `CREATE TABLE`,
  an `INSERT INTO ... SELECT`, and a preview query.
- **New table, stored locally** — produces a remote `SELECT` to fetch
  and transform, plus a local `CREATE TABLE` and parameterised insert
  for the local workspace.
- **In place** — produces an `ALTER TABLE`, an `UPDATE` / `DELETE`, or
  both. Filtering intent like "keep only X" becomes a delete of rows
  that don't match.

### Document sources

- **New collection** — picks the right approach automatically:
  - **Aggregation pipeline** for filtering, projection, grouping,
    lookups, and computed fields. Ternlux automatically appends the
    final stage that writes the result to the target collection.
  - **Filter operation** for simple subset queries.
  - **Custom JavaScript** for logic that can't be expressed as
    aggregation.
- **In place** — picks update, delete, or in-place JavaScript. In-place
  JavaScript transformations are processed in batches of ten thousand
  documents at a time.

### Local sources

- **Local SQL source, new table** — produces a `CREATE TABLE` and an
  `INSERT` against the local SQL workspace.
- **Local SQL source, in place** — produces an `UPDATE`, `DELETE`,
  `ALTER TABLE`, or any combination thereof.
- **Local document source, new collection** — produces a filter or
  custom JavaScript transformation that writes into a new local
  document collection.
- **Local document source, in place** — produces an update, delete, or
  in-place JavaScript transformation.

## Placeholders

Generated operations may include named placeholders like
`{{current_date}}` and `{{current_timestamp}}`. Ternlux substitutes
them with the actual runtime values when the workflow executes, so
"set archived_date to today" works for every future run without
modification.

## Output format

The generated operation includes a brief explanation in plain language
(what's about to happen and why), the operation itself, and a preview
query that the interactive layer uses to show you a sample of the
result before you save.
