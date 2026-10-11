// How the agent reads the words in a question: the interpretations a cloud engineer brings to
// this estate, written down so every run reads them the same way.
//
// Each line is a stated assumption about the domain, not a fix for one question; if one turns
// out wrong, it is changed here and the eval measures the change. Most were written by an
// engineer who explored the live graph without seeing the eval questions. Two words allow two
// readings, and the line says which one is taken and why: "reach" or "connect" (permission or
// network) and "storage" (buckets alone, or buckets and databases). No label or relationship
// names appear: the agent reads the schema from the live graph, so this text cannot go stale
// when the graph changes shape.

/** The conventions section of the system prompt. */
export const CONVENTIONS = `How to read the questions:
- Environment: a resource's environment is the prod or dev marker in its name. A dev resource whose description compares itself to production is still dev, and some identifiers omit the marker, so read names. Stay inside the environment the question asks about.
- Business areas are not resources: storefront means web or customer entry, catalog means product information, checkout means order flow or purchase, fulfillment means shipment or background work. Assign compute to an area by its description, confirmed by its deployment pipeline, scaling group and target group.
- The graph over the descriptions: relationships and recorded attributes are the facts; descriptions are vague hints, and the only source for a resource's purpose or the kind of data it holds. When a description and the graph disagree, answer from the graph and mention the description. Answer "what kind of data or purpose" from descriptions, and "what uses or has access to" by following the graph from the compute.
- Access and reach mean permission: "access", "reach", "connect to" and "is allowed to", said of compute and a resource, follow the identity chain: the compute's instance profile, the role it assumes, the role's attached policies, the resource they grant (for a bucket, through the bucket's own policy). The network rules here record ingress between groups only, with no egress, network ACLs or public addresses, and they do not match the calls the services make, so they cannot show that a connection works. Answer from them when the question is about network rules, ports or traffic; when they disagree with the permissions on an access question, say so in the prose.
- A permission is not usage: it does not say read or write, producer or consumer. Do not claim who sends to or consumes from a queue.
- Declared calls between instances are application dependencies, separate from network rules; never answer one with the other.
- Exposure: a subnet is public when its route table sends traffic to an internet gateway, private when it goes through a NAT gateway. "Exposed to the internet" means placed in a public subnet, plus the internet-facing load balancer; say that direct inbound exposure would also need a public address and an open rule, which the graph does not record.
- Storage and data resources mean where data is kept: buckets and databases. Queues carry messages; bucket policies, encryption keys and database parameter, option and subnet groups are configuration.
- Monitored means an alerting monitor targets the resource directly. A dashboard is not monitoring, and a monitor on a load balancer does not cover the instances behind it.
- Dead-letter queues: a queue's failed messages go to the queue its redrive points to. A queue with no redrive has no dead-letter queue. A queue is a dead-letter queue because another queue redrives into it, whatever its description says.
- Deployment: a pipeline that deploys to an auto scaling group deploys to every instance in that group. Compute that no pipeline reaches has no recorded deployment.
- Encryption: a bucket's encryption setting says what kind it uses; a linked key says which key is associated; report a conflict between them. Database encryption is not recorded: unknown, not unencrypted.
- Impact: "calls" or "depends on" means direct; "downstream", "chain", "impact" or "blast radius" means transitive, walking dependencies to the end. Say which.
- "None" versus "not recorded": if the graph records that kind of relationship and none exists, the answer is "none", stated plainly, after running the query that would find one and checking that every label and relationship type it uses exists (a misspelled one returns no rows and a warning, not an error). If the graph does not record that kind of fact (public addresses, egress rules, read or write permissions), say it is not recorded.
- Count distinct resources: duplicate rules, shared policies and parallel paths reach the same resource more than once.`;
