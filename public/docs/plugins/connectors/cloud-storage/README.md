# Cloud storage connectors

Cloud storage connectors give Ternlux access to bucket-style storage
systems: object stores like S3, file-sharing services like Drive and
OneDrive, and document libraries like SharePoint.

They share a common surface:

- **Containers** — buckets (S3, GCS, Azure), top-level folders
  (Drive, OneDrive), document libraries (SharePoint), or "all files"
  (Dropbox).
- **Objects** — files inside a container. Listed with pagination
  and optional prefix filtering.
- **Download** — fetch an object's contents.
- **Upload** — write an object's contents.
- **Delete** — remove an object.
- **Get metadata** — size, modified time, content type.

> **Note:** Cloud storage cannot be added to workflows through the
> chat assistant for now. You configure and use cloud storage
> connectors directly through the node UI.

## How they're used by nodes

- **Data Source nodes.** Point at a single object. At execution time
  the object is downloaded and imported into the local workspace —
  spreadsheets / Parquet / Avro into the local SQL workspace, JSON
  into a local document collection. The container name is used as a
  prefix on the resulting table or collection name to avoid collisions
  when you import the same filename from different containers.
- **Output nodes.** Point at a container plus an object path. The
  output data is serialised to JSON or CSV (chosen by the file
  extension you provide) and uploaded.

## Available connectors

| Connector | Auth | Notes |
| --- | --- | --- |
| [Amazon S3](s3.md) | AWS access key + secret | S3-compatible endpoints (MinIO, etc.) supported |
| [Google Cloud Storage](gcs.md) | Service account JSON or key file | Inline JSON or path to a key file |
| [Azure Blob Storage](azure-blob.md) | Connection string or account key | Two auth methods supported |
| [Google Drive](google-drive.md) | OAuth | File IDs, format export |
| [OneDrive](onedrive.md) | OAuth | Microsoft Graph, multi-tenant aware |
| [SharePoint](sharepoint.md) | OAuth | Microsoft Graph, site / drive model |
| [Dropbox](dropbox.md) | OAuth | Team-space detection |

## OAuth auto-refresh

For OAuth-based connectors (Drive, OneDrive, SharePoint, Dropbox),
Ternlux refreshes the access token automatically within a five-minute
buffer of expiry, so a workflow run never lands on a stale token.
