/**
 * BambooHR API preset.
 *
 * Facts cross-checked against BambooHR's API docs, the Airbyte source-bamboo-hr
 * manifest and docs (https://api.bamboohr.com/api/gateway.php/<company>/v1,
 * HTTP Basic with the key as username and "x" as password, directory,
 * custom report, time-off and timesheet streams) and the n8n BambooHR node
 * (employee, file, report operations). Only facts about the vendor's API are
 * recorded here.
 */

module.exports = {
  id: 'bamboohr',
  title: 'BambooHR',
  description: 'Employees (any fields), the employee directory, custom reports, time off, who\'s out, timesheets and field definitions.',
  docsUrl: 'https://documentation.bamboohr.com/reference',
  baseUrl: null,
  baseUrlPlaceholder: 'https://api.bamboohr.com/api/gateway.php/yourcompany/v1',
  baseUrlHelp: 'Replace "yourcompany" with your BambooHR subdomain (yourcompany.bamboohr.com).',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'BambooHR API key', helpText: 'BambooHR → your photo → API Keys → Add new key. It has the permissions of the user who creates it.' },
  ],

  basicAuth: { username: '{API key}', password: 'x' },
  headers: { Accept: 'application/json' },

  test: { path: '/meta/users/' },

  pagination: 'None — each endpoint returns everything in one response.',

  endpoints: [
    { path: '/employees/directory', rows: '`employees` array', label: 'Employee directory (names, job titles, departments, locations)' },
    { method: 'POST', path: '/reports/custom', rows: '`employees` array', label: 'Custom report — any employee fields for everyone',
      params: 'query format=JSON, onlyCurrent=false; body: { title: "export", fields: ["firstName","lastName","workEmail","department","jobTitle","hireDate","terminationDate","status","supervisor"] }' },
    { path: '/employees/{id}', rows: 'one object', label: 'One employee with chosen fields', params: 'fields=firstName,lastName,department,payRate' },
    { path: '/employees/changed', rows: '`employees` object keyed by id', label: 'Employees changed since a time', params: 'since=<ISO-8601>, type=inserted|updated|deleted' },
    { path: '/time_off/requests', rows: 'the body is the array', label: 'Time-off requests', params: 'start=YYYY-MM-DD, end=YYYY-MM-DD, status=approved|requested|denied, type' },
    { path: '/time_off/whos_out', rows: 'the body is the array', label: 'Who\'s out (approved time off and holidays)', params: 'start, end' },
    { path: '/time_tracking/timesheet_entries', rows: 'the body is the array', label: 'Timesheet entries', params: 'start, end, employeeIds' },
    { path: '/meta/fields', rows: 'the body is the array', label: 'Every field name you can request' },
    { path: '/meta/lists', rows: 'the body is the array', label: 'List-field options (departments, divisions…)' },
  ],

  notes: [
    'Field names are camelCase (firstName, workEmail, hireDate); custom fields are customXxx — see /meta/fields.',
    'The API key acts as the user who made it; fields that user cannot see come back empty or 403.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/employees', label: 'Add an employee', batch: 1, upsert: null, body: '{ firstName, lastName, workEmail?, hireDate?, department?, jobTitle? }',
        notes: 'The new id is the last segment of the Location response header.' },
      { method: 'POST', path: '/employees/{id}', label: 'Update an employee', batch: 1, upsert: 'employee id', body: '{ …fields to change }' },
    ],
    notes: ['No upsert: match on workEmail or employeeNumber from the directory or a custom report, then update by id.'],
  },
};
