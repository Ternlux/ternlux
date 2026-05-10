# Python Executor skill

A transformer-only skill that runs AI-authored Python code for
transformations that vanilla SQL or NoSQL operations can't express
cleanly.

## When the AI picks this skill

The assistant offers this skill when your transformation request:

- Needs computational logic that doesn't translate well to SQL —
  rolling windows, statistical calculations, data science
  transformations, fuzzy text processing.
- Benefits from a real Python ecosystem (pandas, numpy, scikit-learn,
  etc.).
- Mixes data shaping with analytical computation in a way SQL would
  obscure.

For pure data movement and reshaping, the assistant prefers vanilla
SQL or NoSQL because they're cheaper to run and easier to read.

## How it works at run time

The skill loads the source data, runs the AI-written Python code
against it inside a managed Python environment, and writes the
returned result to the chosen destination — either back into a
database, into the local SQL workspace, or into a local document
collection, depending on what you picked.

The Python environment is set up by the skill's installer script
(`setup.sh` on macOS / Linux, `setup.bat` on Windows) which creates a
virtual environment and installs the required packages.

## Prerequisites

- Python is installed on your machine.
- The setup script has been run once after installing the skill.

If Python isn't found, the skill returns a clear error pointing you
to the setup instructions.
