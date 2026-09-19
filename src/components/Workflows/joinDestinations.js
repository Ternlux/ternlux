// Where a join can write its result — the destination list behind the
// ChatAssistant's focused-join picker.
//
// The rules (categorize every saved connection, plus one local Parquet option)
// follow the legacy JoinNodeChat picker, which is where a join used to be
// configured. Plain data only; the caller renders it.
import { connectionsDb } from '../../utils/localDb';

export const DESTINATION_GROUP_COLOR = {
  'Cloud Storage': '#0891b2',
  APIs: '#2563eb',
  Vector: '#16a34a',
  Databases: '#7c3aed',
  'Local Files': '#d97706',
  Other: '#5a6678',
};

export const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

export const categorizeConnection = (conn) => {
  if (!conn) return 'Other';
  if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
  if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

// The one local destination: the join result is written as a Parquet file the
// node owns and read back through DuckDB. Tabular and document data alike —
// there is no local SQLite destination any more.
export const LOCAL_FILE_DESTINATION = {
  id: 'local-duckdb',
  label: 'Local file',
  value: 'local-duckdb',
  description: 'Store the result as a local Parquet file (read with DuckDB)',
  connection: { dbType: 'duckdb', connectionType: 'file' },
  group: 'Local Files',
  groupColor: DESTINATION_GROUP_COLOR['Local Files'],
};

/**
 * Every saved connection (deduplicated, categorized) plus the local Parquet
 * file option. Returns plain data; attach icons in the caller.
 */
export const loadJoinDestinations = async () => {
  let allConnections = [];
  try {
    allConnections = (await connectionsDb.getAll()) || [];
  } catch (err) {
    console.warn('[joinDestinations] could not load connections:', err.message);
  }

  const destinations = [];
  const seen = new Set();
  allConnections.forEach((conn) => {
    if (!conn || seen.has(conn.id)) return;
    seen.add(conn.id);
    const group = categorizeConnection(conn);
    destinations.push({
      id: conn.id,
      label: conn.name,
      value: conn.id,
      description: `Store in ${conn.name} (${conn.dbType})`,
      connection: conn,
      group,
      groupColor: DESTINATION_GROUP_COLOR[group] || DESTINATION_GROUP_COLOR.Other,
    });
  });

  destinations.push({ ...LOCAL_FILE_DESTINATION });
  return destinations;
};

/**
 * Has this join node been told where to write? Mirrors what the join builder
 * treats as "destination already settled" — an explicit selection token, or a
 * resolved target connection on the config.
 */
export const hasJoinDestination = (config) => {
  if (!config) return false;
  return !!(config.joinSettings?.destinationSelection
    || config.targetConnectionId
    || config.targetDbType);
};
