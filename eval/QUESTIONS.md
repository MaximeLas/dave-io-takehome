# Evaluation Questions

Your submission is evaluated against the 30 questions below, each tagged with
its eval id. You get the questions, not the answers: deciding what a good answer
consists of — which resources are relevant, how far to traverse, what to cite —
is part of the assignment. Some are answerable from node descriptions alone,
others only by traversing relationships, and at least one has an empty answer.

`eval/expected.generated.json` holds a set of expected resource ids per
question, keyed by the same id and derived directly from the graph. Treat it as
a recommended reference for what a correct answer contains, not as the whole
rubric. You are expected to evaluate your answers on further metrics of your own
choosing; working out what else is worth measuring, and how, is part of the
assignment.

## Questions

- `prod-order-queue-dlq` — If messages in the production order queues keep failing, where do they end up?
- `queues-without-dlq` — Which SQS queues have no dead-letter queue configured?
- `dlq-for-prod-2` — Where do failed messages from queue-commerce-prod-2 go?
- `dlq-source-reverse` — queue-commerce-prod-15 is filling up. Which queue is the source of those messages?
- `dev-dlq-targets` — Which dev queues act as dead-letter targets?
- `fulfillment-backing-up` — What should I inspect if fulfillment jobs are backing up?
- `unmonitored-prod-queues` — Which production queues have no monitor watching them?
- `dev-compute-storage` — What storage can the dev compute resources access?
- `path-compute-to-s3` — Trace how i-ecomm-prod-01 reaches its S3 bucket.
- `who-can-reach-prod-bucket-1` — Which compute instances can reach bucket-commerce-prod-1?
- `who-can-reach-prod-rds-4` — Which instances can connect to rds-commerce-prod-4?
- `downstream-of-prod-01` — What is downstream of i-ecomm-prod-01 in the service call chain?
- `queues-for-prod-04` — Which queues can i-ecomm-prod-04 access?
- `prod-checkout-resources` — Which prod resources are related to checkout or order flow?
- `catalog-resources` — Which production resources support catalog or product data?
- `fulfillment-resources` — Which resources are involved in fulfillment?
- `storefront-resources` — Which resources serve storefront or customer-facing traffic?
- `dev-compute-stack` — What is the compute stack in my dev env?
- `workflows-deploy-prod-compute` — Which GitHub workflows deploy to production compute?
- `repo-behind-dev-02` — Which repository's code ends up on i-ecomm-dev-02?
- `monitors-queues-dbs` — Which Datadog monitors are related to queues or databases?
- `deploy-blast-radius` — If the workflow in acme-commerce/repo-commerce-prod-1 runs, which instances are affected?
- `most-shared-resources` — Which resources are reachable from the largest number of distinct compute instances?
- `queues-outside-redrive` — Which queues are neither a redrive source nor a dead-letter target?
- `security-groups-most-rules` — Which security groups have the most rules attached?
- `unmonitored-prod-data` — Which production data resources have no monitoring?
- `dev-reaching-prod-storage` — Can any dev compute instance reach production storage?
- `workflows-deploying-to-databases` — Do any GitHub workflows deploy directly to a database?
- `order-flow-instances-actual-access` — The instances described as order-flow — which data resources do they actually have access to?
- `which-dlq-serves-the-purchase-queue` — queue-commerce-prod-1 handles purchase events. Which of the dead-letter queues is its DLQ?
