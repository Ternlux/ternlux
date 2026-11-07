# 23-rest-api-presets

**Area:** connections tab, workflow editor (Data Source form), chat assistant (builder)
**Uses:** a GitHub connection and a HubSpot connection made from the presets (the user creates them with their own token / service key — never type a credential)
**Cost:** two or three Data Source builds
**Requires:** AI provider OpenAI, model `gpt-6-luna` (or whatever the run names)

## Ground truth
Recompute before each run without a token — these change slowly:
- `GET https://api.github.com/repos/golang/go/labels?per_page=100` → **146** labels over **2** pages (the `Link` header has rel="next" on page 1).
- `GET https://api.github.com/repos/octocat/Hello-World/branches` → **3** branches.
- HubSpot test account: as many contacts as the user imported (ask them); above 100 means paging was followed.

## Steps
1. **Connections tab.** The GitHub and HubSpot connections show the vendor's
   badge and chip (not "rest-api"). Category **APIs** lists them (with any plain
   REST API connection); **Databases** does not. The **Type** filter offers
   GitHub and HubSpot.
2. **Picker.** Add connection → APIs lists GitHub and HubSpot tiles. Open each
   form (do not save): it asks only for the token / service key plus a
   pre-filled Base URL. Cancel.
3. **Data Source form.** New workflow `E2E presets`. Add a Data Source, pick the
   GitHub connection: the APIs group shows it as "GitHub · API" with the GH
   badge, and an **Endpoint** card appears. Pick *Labels*, Details
   `golang/go`. Save → the chat opens with the box pre-filled
   "Pull Labels from GitHub (GET /repos/{owner}/{repo}/labels). golang/go".
4. Send it. Approve the fetch code when asked. → **146** rows. The code uses
   `{{PERSONAL_ACCESS_TOKEN}}` (no literal token), sends
   `X-GitHub-Api-Version`, and follows the `Link` header.
5. Reopen the node: Endpoint still shows *Labels*, Details `golang/go`.
6. Second Data Source, same GitHub connection, *no* endpoint picked. In chat:
   "List the branches of octocat/Hello-World." → **3** rows.
7. Third Data Source on HubSpot. Endpoint *Contacts*, Details
   `email, firstname, lastname`. Save, send the pre-filled request, approve.
   → every imported contact, with `email`, `firstname`, `lastname` as columns
   (flattened out of `properties`). The code uses `{{ACCESS_TOKEN}}` and
   follows `paging.next.after`.

## Checks
- [ ] Step 1: badges, APIs category and Type filter correct
- [ ] Step 2: both preset forms ask only for the credential + Base URL
- [ ] Step 3: endpoint card, pre-filled draft
- [ ] Step 4: 146 labels; placeholder, version header, Link paging
- [ ] Step 5: pick survives reopening
- [ ] Step 6: 3 branches without a pick
- [ ] Step 7: contact count matches; columns flattened; placeholder; cursor paging
- [ ] No credential in any chat message, node panel, generated code or log
- [ ] No renderer console errors or main-process errors

## Cleanup
Delete workflow `E2E presets`. Leave the connections.
