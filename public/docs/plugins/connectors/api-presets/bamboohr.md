# BambooHR

Employees (any fields), the employee directory, custom reports, time off, who's out, timesheets and field definitions.
See [Vendor API connections](README.md) for how these connections work in general.

## Get a key

7-day free trial is enough to try it.

1. Click your photo (top right) → **API Keys** → **Add New Key**.
2. Name it and copy it. It has the permissions of your user.
3. Base URL: `https://api.bamboohr.com/api/gateway.php/yourcompany/v1`.

## Add the connection

| Field | What to enter |
| --- | --- |
| Base URL | Replace "yourcompany" with your BambooHR subdomain (yourcompany.bamboohr.com). |
| API key | BambooHR → your photo → API Keys → Add new key. It has the permissions of the user who creates it. |

**Test connection** calls `GET /meta/users/`.

## Sample data

A trial includes sample employees; add a time-off request to see that data.

## What you can read

- Employee directory (names, job titles, departments, locations)
- Custom report — any employee fields for everyone
- One employee with chosen fields
- Employees changed since a time
- Time-off requests
- Who's out (approved time off and holidays)
- Timesheet entries
- Every field name you can request
- List-field options (departments, divisions…)

## Good to know

- Field names are camelCase (firstName, workEmail, hireDate); custom fields are customXxx — see /meta/fields.
- The API key acts as the user who made it; fields that user cannot see come back empty or 403.

## Writing to BambooHR

An Output node or a Join can send rows to BambooHR (see [Sending rows to an API](README.md#sending-rows-to-an-api)):

- Add an employee
- Update an employee — matches on employee id

- No upsert: match on workEmail or employeeNumber from the directory or a custom report, then update by id.

## Troubleshooting

- **403 on a field:** your user cannot see it.
- **404:** the company subdomain in the base URL is wrong.
