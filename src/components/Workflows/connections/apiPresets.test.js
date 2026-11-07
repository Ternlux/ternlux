import {
  splitConnectorKey,
  connectorKeyFor,
  resolveConnectorPlugin,
  presetForConnection,
  endpointKey,
  endpointRequestDraft,
  endpointVariables,
} from './apiPresets';
import { connectorVisual } from './connectorCatalog';

// The preset data the REST API plugin lists to the renderer.
const { PRESETS } = require('../../../../plugins/connectors/rest-api/presets');

const restPlugin = {
  id: 'rest-api',
  name: 'REST API',
  dbCategory: 'API',
  authType: 'custom',
  configSchema: { fields: [{ name: 'baseUrl' }, { name: 'apiParams', type: 'keyValue', sensitive: true }] },
  presets: PRESETS,
};
const installed = [restPlugin, { id: 'postgres', name: 'PostgreSQL' }];
const githubConn = { id: 'c1', dbType: 'rest-api', dbConfig: { presetId: 'github' } };

describe('picker keys', () => {
  test('split a preset key and a plain plugin key', () => {
    expect(splitConnectorKey('rest-api:github')).toEqual({ pluginId: 'rest-api', presetId: 'github' });
    expect(splitConnectorKey('postgres')).toEqual({ pluginId: 'postgres', presetId: null });
  });

  test('a saved connection maps back to the tile that made it', () => {
    expect(connectorKeyFor(githubConn)).toBe('rest-api:github');
    expect(connectorKeyFor({ dbType: 'rest-api', dbConfig: {} })).toBe('rest-api');
    expect(connectorKeyFor({ dbType: 'postgres' })).toBe('postgres');
  });

  test('every preset has a catalog tile', () => {
    for (const p of PRESETS) {
      const tile = connectorVisual(`rest-api:${p.id}`);
      expect(tile).toBeTruthy();
      expect(tile.title).toBe(p.title);
    }
  });
});

describe('resolveConnectorPlugin', () => {
  test('dresses the REST plugin as the vendor', () => {
    const p = resolveConnectorPlugin(installed, 'rest-api:hubspot');
    expect(p.id).toBe('rest-api');
    expect(p.name).toBe('HubSpot');
    expect(p.presetId).toBe('hubspot');
    const names = p.configSchema.fields.map((f) => f.name);
    expect(names).toEqual(['presetId', 'presetCredential_0', 'baseUrl']);
    expect(p.configSchema.fields[0].default).toBe('hubspot');
    expect(p.configSchema.fields[1]).toMatchObject({ type: 'presetCredential', paramKey: 'Access token', required: true });
    expect(p.configSchema.fields[2].default).toBe('https://api.hubapi.com');
  });

  test('plain keys and missing plugins/presets', () => {
    expect(resolveConnectorPlugin(installed, 'postgres').name).toBe('PostgreSQL');
    expect(resolveConnectorPlugin(installed, 'rest-api')).toBe(restPlugin);
    expect(resolveConnectorPlugin(installed, 'rest-api:nope')).toBeNull();
    expect(resolveConnectorPlugin([{ ...restPlugin, presets: null }], 'rest-api:github')).toBeNull();
    expect(resolveConnectorPlugin([], 'rest-api:github')).toBeNull();
  });
});

describe('endpoint picker helpers', () => {
  test('presetForConnection finds the preset only for preset connections', () => {
    expect(presetForConnection(installed, githubConn).id).toBe('github');
    expect(presetForConnection(installed, { dbType: 'rest-api', dbConfig: {} })).toBeNull();
    expect(presetForConnection([], githubConn)).toBeNull();
  });

  test('endpointKey defaults the method to GET', () => {
    expect(endpointKey({ path: '/crm/v3/owners' })).toBe('GET /crm/v3/owners');
    expect(endpointKey({ method: 'POST', path: '/crm/v3/objects/{object}/search' }))
      .toBe('POST /crm/v3/objects/{object}/search');
  });

  test('endpointVariables lists path variables, choices and options', () => {
    const gh = PRESETS.find((p) => p.id === 'github');
    const hs = PRESETS.find((p) => p.id === 'hubspot');
    const issues = gh.endpoints.find((e) => e.path === '/repos/{owner}/{repo}/issues');
    expect(endpointVariables(issues)).toEqual({
      required: [{ name: 'owner', choices: null }, { name: 'repo', choices: null }],
      optional: issues.params,
    });
    const pipelines = hs.endpoints.find((e) => e.path === '/crm/v3/pipelines/{deals|tickets}');
    expect(endpointVariables(pipelines).required).toEqual([{ name: 'type', choices: ['deals', 'tickets'] }]);
    expect(endpointVariables({ path: '/user/repos' })).toEqual({ required: [], optional: null });
  });

  test('the chat draft names the endpoint and leaves its variables to fill in', () => {
    const gh = PRESETS.find((p) => p.id === 'github');
    const issues = gh.endpoints.find((e) => e.path === '/repos/{owner}/{repo}/issues');
    expect(endpointRequestDraft(gh, issues))
      .toBe('Pull Issues from GitHub (GET /repos/{owner}/{repo}/issues) for owner: , repo: ');
    const repos = gh.endpoints.find((e) => e.path === '/user/repos');
    expect(endpointRequestDraft(gh, repos))
      .toBe('Pull Repositories the token can see from GitHub (GET /user/repos).');
  });
});
