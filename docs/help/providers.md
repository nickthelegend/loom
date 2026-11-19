# Connect a model provider in four steps

Open Settings ▸ Setup ▸ Provider setup guide on the web, or run `loom providers:guide` in a project:

1. Choose a provider and add its key. Custom providers also need a base URL.
2. Test the saved key by fetching the provider's model list. A failed request stops the guide; correct the credentials and retry.
3. Pick a model from the returned list. The default model alias points to it.
4. Choose a project and add a model agent. That agent becomes the project's default agent.

The key stays in the daemon's private provider store and is never returned in the guide response. Changing the key or destination invalidates the successful test. Existing provider settings and model controls still work.

Provider configuration is machine-wide, so use the owner or an unscoped paired device. Project-scoped tokens cannot change it. The guide tests authentication and model listing, not the quality of model responses.
