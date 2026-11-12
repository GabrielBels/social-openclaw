# Instagram Backblaze B2 Design

> Design date: 2026-10-15

## Overview

The Instagram publisher stages approved JPEGs in a private Backblaze B2 bucket. A one-hour download authorization scoped to each attempt's random image key allows Instagram to fetch it. Gabriel selected B2 after comparing it with R2 and declined the public-bucket verification payment. Hosting on the personal OpenClaw PC would require a public endpoint and availability during media fetching.

## Storage and credentials

Use the B2 Native API with built-in Node modules. An operator-only hidden prompt stores the complete Basic authorization header as `INSTAGRAM_B2_BASIC_AUTH`, a protected OpenClaw secret bound to `api.backblazeb2.com`. The publisher receives only its sentinel. `INSTAGRAM_B2_BUCKET_ID` and `INSTAGRAM_B2_BUCKET_NAME` are non-secret store entries.

An application key is restricted to the dedicated bucket and permits writing, listing, deleting and sharing files. Each publication authorizes a B2 session; its short-lived account, upload and download tokens remain only in the trusted publisher's process memory. They are never written to a workspace, output or local log. Validate returned HTTPS API, download and upload destinations and refuse redirects before sending credentials.

After each upload, request `b2_get_download_authorization` with that exact random key as `fileNamePrefix` and `validDurationInSeconds: 3600`. Only this read authorization goes to Meta in the image URL's `Authorization` query parameter; account and upload tokens never leave the publisher's B2 requests. Anyone holding that temporary URL can read files matching its random prefix until expiry or deletion. Meta error text is redacted before truncation and output to prevent reflected links or tokens entering the chat.

Use JPEG content type, explicit content length and SHA-1. Delete the exact uploaded version in `finally`. If upload completion is uncertain, list versions of that exact random key and remove them. Report cleanup failures without changing the publication outcome. Bucket lifecycle rules provide fallback removal.

## Alternatives

R2 reuses the existing implementation but does not meet the selected provider choice. B2's S3 API requires signing with a real application key inside the publisher; the Native API preserves the long-lived key's OpenClaw protection without adding a signing dependency.

## Testing

Mock API contracts for authorization, scoped bucket restrictions, upload, one-hour private download access, hostile destinations, redirection, reflected credentials, version deletion and uncertain upload cleanup. Exercise the complete publisher's single-image, carousel and failure flows. Keep runtime authentication, unauthenticated download denial, temporary download success and actual Instagram processing separate from mocked evidence.

## Acceptance Criteria

- [ ] Approved posts upload JPEGs to private B2 storage and supply one-hour, image-scoped download URLs to Instagram.
- [ ] The permanent key is a protected, host-bound OpenClaw secret entered through a hidden operator prompt.
- [ ] Credentials and temporary tokens appear in no output, file or log.
- [ ] The publisher rejects wrong bucket restrictions, missing capabilities, unsafe endpoints, redirects and download access for another bucket or prefix.
- [ ] Reflected download credentials are redacted before provider errors are truncated or printed.
- [ ] Cleanup deletes uploaded versions, including an upload whose response was lost, or reports failure.
- [ ] Tests and operator instructions cover B2 setup and failure recovery without an R2 prerequisite.

## Boundaries

The global dedicated-worktree, credential, dependency and no-commit rules apply. No dependency is added. The bucket stays private; no public-bucket verification payment is made. Application credentials and automatic permanent deletion require the applicable browser confirmation or operator action. Runtime deployment and posting require separate integration evidence.
