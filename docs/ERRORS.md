# API error codes

Every error response looks like:

```json
{ "error": { "code": "TRIP_ALREADY_TAKEN", "message": "Another driver accepted this trip", "details": {} } }
```

Apps switch on `code`, never on `message` (the message is English and meant for developers). Show your own
localised text (Amharic / English / Afaan Oromo / Tigrinya). `details` is present only where noted.

This list is checked by `apps/api/test/errors.test.ts`: adding a code in the API without documenting it here
fails the build.

## General

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | Request body or query is invalid. `details` = list of issues with `path` and `message`. | Highlight the fields in `details[].path`; it's usually an app bug if it reaches users. |
| `UNAUTHENTICATED` | 401 | No access token, or the route needs a signed-in user. | Go to login. |
| `INVALID_TOKEN` | 401 | Access token expired or malformed. | Call `POST /auth/refresh` once, retry the request; if refresh fails, go to login. |
| `ACCOUNT_INACTIVE` | 401 | The account was suspended or deleted after this token was issued. | Sign out locally; show "Your account is not active, contact support". |
| `FORBIDDEN` | 403 | Wrong role for this route (e.g. a rider calling a driver route), or a database rule refused the change. | Treat as an app bug; don't retry. |
| `MISSING_PERMISSION` | 403 | Staff member lacks the permission. `details.needed` = permissions that would allow it. | Back office: hide or disable the action; "Ask an admin for access". |
| `NOT_FOUND` | 404 | The item doesn't exist or isn't visible to you. | Show "not found"; refresh the list. |
| `ROUTE_NOT_FOUND` | 404 | No such endpoint. | App bug (wrong URL or API version). |
| `ALREADY_EXISTS` | 409 | Duplicate (e.g. rating the same trip twice). | Treat as success where the action is idempotent. |
| `RATE_LIMITED` | 429 | Too many requests from this user or network. | Back off, retry later; tell the user to wait a moment. |
| `INTERNAL` | 500 | Unexpected server error (logged). | Generic "Something went wrong, try again". |
| `MAPS_UNAVAILABLE` | 502 | Place search failed (Gebeta). | Let the user drop a pin on the map instead of searching. |

## Accounts and login

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `ACCOUNT_EXISTS` | 409 | Registering a phone that already has an account for this role. | Offer "Log in instead". |
| `WEAK_PASSWORD` | 422 | Password under 10 characters, contains the phone number, one repeated character, or equal to the temporary one. | Show the rule; keep the form filled. |
| `INVALID_CREDENTIALS` | 401 | Wrong phone or password (deliberately the same for both). | "Wrong phone number or password". |
| `ACCOUNT_LOCKED` | 423 | 5 wrong passwords; `details.lockedUntil` (ISO time). | "Too many attempts, try again at …"; offer support contact. |
| `ACCOUNT_SUSPENDED` | 403 | Correct password, but the account is suspended. | "Your account is suspended, contact support". |
| `PASSWORD_CHANGE_REQUIRED` | 409 | Signed in with a temporary password. | Ask for a new password, then repeat `POST /auth/login` with `newPassword`. |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token expired, revoked or reused. | Go to login. |

## Trips

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `OUT_OF_SERVICE_AREA` | 422 | Pickup is outside the operating zones. | "We don't operate here yet"; let them move the pin. |
| `RESTRICTED_AREA` | 422 | Pickup or drop-off is in a no-go zone. | Ask for a different point nearby. |
| `UNKNOWN_CATEGORY` | 422 | Vehicle type doesn't exist or is switched off. | Reload the categories (`GET /catalog/vehicle-categories`). |
| `ACTIVE_TRIP_EXISTS` | 409 | The rider already has a trip in progress. | Open that trip (`GET /trips?limit=1`). |
| `INVALID_TRANSITION` | 409 | The action doesn't fit the trip's current status (e.g. cancelling a started ride). | Re-fetch `GET /trips/{id}` and show the current state. |
| `WRONG_RIDE_PIN` | 422 | Driver entered a PIN that doesn't match. | "PIN doesn't match, ask the rider again". |

## Drivers

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `DRIVER_NOT_APPROVED` | 403 | Going online before approval. | Show the approval status screen. |
| `NO_ACTIVE_VEHICLE` | 422 | No approved vehicle selected. | Send to the vehicles screen. |
| `ON_TRIP` | 409 | Going online while on a trip. | Return to the active trip. |
| `OFFER_NOT_AVAILABLE` | 409 | Offer expired or was withdrawn before accepting. | Dismiss the offer card quietly. |
| `TRIP_ALREADY_TAKEN` | 409 | Another driver accepted first. | "Taken by another driver"; dismiss. |
| `DRIVER_BUSY` | 409 | Accepting while already on a trip. | Return to the active trip. |
| `PLATE_TAKEN` | 409 | Plate already registered. | "This plate is already registered, contact support". |
| `DEPOSIT_REQUIRED` | 402 | Prepaid deposit balance is below the threshold (going online or accepting). `details` = wallet status (`balance`, `threshold`, `minDeposit`, …). | "Top up your deposit (at least `minDeposit`) at the office to take trips". |

## Driver documents

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `DOCUMENT_NOT_UPLOADED` | 409 | Submitting before the file reached storage, or with a different size. | Upload again from step 1 (the link may have expired). |
| `UPLOAD_MISMATCH` | 422 | The uploaded file's type or size differs from what was declared (development storage). | Re-request the upload with the real type and size. |
| `INVALID_SIGNATURE` | 403 | Upload/download link is invalid or expired (development storage). | Request a new link. |
| `DOCUMENT_EXPIRED` | 422 | Back office: approving a document whose expiry date has passed. | Reject it and ask the driver for a current one. |
| `DOCUMENTS_INCOMPLETE` | 422 | Back office: approving a driver or vehicle before every required document is approved. `details.missing` lists them. | Review the listed documents first. |

## Deposits and refunds

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `DEPOSIT_TOO_SMALL` | 422 | Back office: deposit below the minimum. `details.minDeposit`. | Collect at least the minimum. |
| `REFUND_NOT_ELIGIBLE` | 422 | Refund requested before the refund period has passed since approval. `details.eligibleFrom`, `details.refundAfterDays`. | "You can request a refund from …". |
| `NOTHING_TO_REFUND` | 422 | Deposit balance is zero (or negative). | Hide the refund button when the balance is 0. |
| `REFUND_ALREADY_REQUESTED` | 409 | A refund request is already pending. | Show the pending request. |

## Back office

| Code | HTTP | Meaning | What the app should do |
|---|---|---|---|
| `CANNOT_CHANGE_SELF` | 422 | Changing your own status. | Explain; another admin must do it. |
| `STAFF_EXISTS` | 409 | A staff account already uses that phone. | Edit the existing staff member instead. |
