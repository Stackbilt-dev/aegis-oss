// GitHub Projects v2 -- GraphQL API
// Separate from github.ts (REST) because GraphQL has fundamentally
// different request patterns (single endpoint, query strings, variables).

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const RETRY_STATUSES = new Set([500, 502, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

// --- Types ---

export interface ProjectField {
  id: string;
  name: string;
  options?: { id: string; name: string }[];
}

export interface ProjectItem {
  id: string;
  content: {
    __typename: string;
    number: number;
    title: string;
    state: string;
    repository: { nameWithOwner: string };
    labels: { nodes: { name: string }[] };
    assignees: { nodes: { login: string }[] };
  } | null;
  fieldValues: {
    nodes: { field?: { name: string }; name?: string }[];
  };
}

export interface BoardStatus {
  backlog: string;   // option ID
  queued: string;
  in_progress: string;
  blocked: string;
  shipped: string;
}

// --- Core GraphQL fetch ---

export async function ghGraphQL<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'aegis-worker/1.0',
      },
      body: JSON.stringify({ query, variables }),
    });

    // Rate limit
    if (res.status === 403 || res.status === 429) {
      const body = await res.text();
      throw new Error(`GitHub GraphQL ${res.status}: ${body}`);
    }

    // Transient server errors
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[github-projects] ${res.status}, retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub GraphQL ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
    }
    return json.data as T;
  }

  throw new Error('GitHub GraphQL: exhausted retries');
}

// --- Project Discovery ---

/** Find an existing org-level project by title, or create one. */
export async function findOrCreateProject(
  token: string,
  orgLogin: string,
  title: string,
): Promise<string> {
  // Search existing projects
  const searchData = await ghGraphQL<{
    organization: {
      projectsV2: { nodes: { id: string; title: string }[] };
    };
  }>(token, `
    query($org: String!, $search: String!) {
      organization(login: $org) {
        projectsV2(first: 20, query: $search) {
          nodes { id title }
        }
      }
    }
  `, { org: orgLogin, search: title });

  const existing = searchData.organization.projectsV2.nodes.find(p => p.title === title);
  if (existing) return existing.id;

  // Create new project — first get org node ID
  const orgData = await ghGraphQL<{
    organization: { id: string };
  }>(token, `
    query($org: String!) {
      organization(login: $org) { id }
    }
  `, { org: orgLogin });

  const createData = await ghGraphQL<{
    createProjectV2: { projectV2: { id: string } };
  }>(token, `
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id }
      }
    }
  `, { ownerId: orgData.organization.id, title });

  return createData.createProjectV2.projectV2.id;
}

// --- Field Management ---

/** Get the Status field and its option IDs. */
export async function getStatusField(
  token: string,
  projectId: string,
): Promise<{ fieldId: string; options: BoardStatus } | null> {
  const data = await ghGraphQL<{
    node: {
      fields: {
        nodes: {
          __typename: string;
          id: string;
          name: string;
          options?: { id: string; name: string }[];
        }[];
      };
    };
  }>(token, `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                __typename id name
                options { id name }
              }
              ... on ProjectV2Field {
                __typename id name
              }
            }
          }
        }
      }
    }
  `, { projectId });

  const statusField = data.node.fields.nodes.find(
    f => f.name === 'Status' && f.__typename === 'ProjectV2SingleSelectField',
  );
  if (!statusField?.options) return null;

  const findOption = (name: string) => statusField.options!.find(o => o.name === name)?.id ?? '';
  return {
    fieldId: statusField.id,
    options: {
      backlog: findOption('Backlog'),
      queued: findOption('Queued'),
      in_progress: findOption('In Progress'),
      blocked: findOption('Blocked'),
      shipped: findOption('Shipped'),
    },
  };
}

// --- Item Operations ---

/** Add an issue or PR to the project board. Returns the project item ID. */
export async function addItemToProject(
  token: string,
  projectId: string,
  contentNodeId: string,
): Promise<string> {
  const data = await ghGraphQL<{
    addProjectV2ItemById: { item: { id: string } };
  }>(token, `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `, { projectId, contentId: contentNodeId });

  return data.addProjectV2ItemById.item.id;
}

/** Update the Status field of a project item. */
export async function updateItemStatus(
  token: string,
  projectId: string,
  itemId: string,
  statusFieldId: string,
  optionId: string,
): Promise<void> {
  await ghGraphQL(token, `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `, { projectId, itemId, fieldId: statusFieldId, optionId });
}

/** List project items with pagination. */
export async function listProjectItems(
  token: string,
  projectId: string,
  cursor?: string,
): Promise<{ items: ProjectItem[]; nextCursor: string | null }> {
  const data = await ghGraphQL<{
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ProjectItem[];
      };
    };
  }>(token, `
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              content {
                ... on Issue {
                  __typename number title state
                  repository { nameWithOwner }
                  labels(first: 10) { nodes { name } }
                  assignees(first: 3) { nodes { login } }
                }
                ... on PullRequest {
                  __typename number title state
                  repository { nameWithOwner }
                  labels(first: 10) { nodes { name } }
                  assignees(first: 3) { nodes { login } }
                }
              }
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    field { ... on ProjectV2SingleSelectField { name } }
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { projectId, cursor: cursor ?? null });

  return {
    items: data.node.items.nodes,
    nextCursor: data.node.items.pageInfo.hasNextPage
      ? data.node.items.pageInfo.endCursor
      : null,
  };
}

/** Get the node ID for an issue (needed to add it to a project). */
export async function getIssueNodeId(
  token: string,
  repo: string,
  number: number,
): Promise<string> {
  const [owner, name] = repo.split('/');
  const data = await ghGraphQL<{
    repository: { issue: { id: string } };
  }>(token, `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) { id }
      }
    }
  `, { owner, name, number });

  return data.repository.issue.id;
}
