MATCH (node)
DETACH DELETE node;

CREATE CONSTRAINT entity_id IF NOT EXISTS
FOR (entity:Entity)
REQUIRE entity.id IS UNIQUE;

CREATE INDEX entity_source IF NOT EXISTS
FOR (entity:Entity)
ON (entity.source);

CREATE INDEX entity_resource_type IF NOT EXISTS
FOR (entity:Entity)
ON (entity.resourceType);

MERGE (n:Entity:AwsVpc {id: 'aws:vpc:vpc-042ecomm-prod'})
SET n.name = 'vpc-042ecomm-prod',
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::VPC',
    n.cidr = '10.42.0.0/16',
    n.description = 'Production-like network boundary for a compact commerce footprint. It suggests a shared environment for web entry, internal application traffic, and data-adjacent resources without naming those concerns as graph nodes.';

UNWIND range(1, 6) AS i
MERGE (n:Entity:AwsSubnet {id: 'aws:subnet:subnet-ecomm-prod-' + toString(i)})
SET n.name = 'subnet-ecomm-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::Subnet',
    n.availabilityZone = CASE WHEN i % 2 = 0 THEN 'us-east-1b' ELSE 'us-east-1a' END,
    n.cidr = '10.42.' + toString(i) + '.0/24',
    n.description = 'Subnet in the commerce VPC. The placement hints at public, private, or data-side usage in a prod-flavored environment, but the exact workload boundary is intentionally indirect.';

UNWIND range(1, 6) AS i
MERGE (n:Entity:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-prod-' + toString(i)})
SET n.name = 'rtb-ecomm-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::RouteTable',
    n.description = 'Route table for a slice of the commerce network. It gives enough routing context to reason about internet-facing and internal paths without spelling out a service map.';

UNWIND range(1, 6) AS i
MERGE (n:Entity:AwsNetworkAcl {id: 'aws:nacl:acl-ecomm-prod-' + toString(i)})
SET n.name = 'acl-ecomm-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::NetworkAcl',
    n.description = 'Network ACL paired with one subnet area. It is a coarse network guardrail for the environment and may matter when tracing why a resource can or cannot be reached.';

MERGE (n:Entity:AwsInternetGateway {id: 'aws:igw:igw-ecomm-prod'})
SET n.name = 'igw-ecomm-prod',
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::InternetGateway',
    n.description = 'Internet gateway attached to the commerce VPC. It is part of the public edge story, but the customer-facing purpose is left as contextual text rather than a separate node.';

UNWIND range(1, 3) AS i
MERGE (n:Entity:AwsNatGateway {id: 'aws:nat:nat-ecomm-prod-' + toString(i)})
SET n.name = 'nat-ecomm-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::NatGateway',
    n.description = 'NAT gateway used by private resources for controlled outbound traffic. It hints at backend compute needing external package, API, or telemetry access in the production-like environment.';

UNWIND range(1, 3) AS i
MERGE (n:Entity:AwsElasticIp {id: 'aws:eip:eip-nat-ecomm-prod-' + toString(i)})
SET n.name = 'eip-nat-ecomm-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::EIP',
    n.description = 'Elastic IP associated with a NAT gateway. It is a small but concrete resource that can help a new hire follow public egress from private parts of the commerce footprint.';

MERGE (n:Entity:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-prod'})
SET n.name = 'alb-commerce-entry-prod',
    n.source = 'aws',
    n.resourceType = 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    n.dnsName = 'commerce-entry.acme.example',
    n.description = 'Application load balancer near the customer entry path. The wording is intentionally soft: it points toward a storefront-like purpose in production without making that purpose a node.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsTargetGroup {id: 'aws:target-group:tg-commerce-prod-' + toString(i)})
SET n.name = 'tg-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::ElasticLoadBalancingV2::TargetGroup',
    n.protocol = 'HTTP',
    n.description = 'Target group for one slice of commerce compute. It suggests runtime grouping and deployment boundaries, but callers must inspect adjacent nodes to infer the purpose.';

UNWIND range(1, 16) AS i
MERGE (n:Entity:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(i), 2)})
SET n.name = 'i-ecomm-prod-' + right('00' + toString(i), 2),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::Instance',
    n.instanceId = 'i-ecomm-prod-' + right('00' + toString(i), 2),
    n.instanceType = CASE WHEN i IN [7, 8, 9, 10] THEN 't3.large' ELSE 't3.medium' END,
    n.description = CASE ((i - 1) % 4)
      WHEN 0 THEN 'EC2 instance in the production commerce environment with a web-entry flavor. It is close to shopper traffic and usually talks inward rather than owning durable state.'
      WHEN 1 THEN 'EC2 instance in the production commerce environment with a product-information flavor. It appears near object assets, catalog-shaped data, and a few internal callers.'
      WHEN 2 THEN 'EC2 instance in the production commerce environment with an order-flow flavor. It sits near purchase state, invoice artifacts, and event handoff resources.'
      ELSE 'EC2 instance in the production commerce environment with a fulfillment-worker flavor. It is near queues, slower background work, and shipment-shaped persistence.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsLaunchTemplate {id: 'aws:launch-template:lt-commerce-prod-' + toString(i)})
SET n.name = 'lt-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::LaunchTemplate',
    n.description = 'Launch template for one recurring compute shape in the commerce environment. It carries hints about how a purpose-specific host is reproduced without saying the purpose too directly.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsAutoScalingGroup {id: 'aws:asg:asg-commerce-prod-' + toString(i)})
SET n.name = 'asg-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::AutoScaling::AutoScalingGroup',
    n.minSize = 2,
    n.maxSize = 6,
    n.description = 'Auto Scaling group for one compute lane in the prod-like commerce footprint. It points to availability and deployment shape more than application semantics.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsSecurityGroup {id: 'aws:sg:sg-commerce-prod-' + toString(i)})
SET n.name = 'sg-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::SecurityGroup',
    n.description = 'Security group for a concrete slice of the commerce environment. Its nearby rules and attachments reveal whether it is closer to edge, application, queue, or data access.';

UNWIND range(1, 20) AS i
MERGE (n:Entity:AwsSecurityGroupRule {id: 'aws:sg-rule:sgr-commerce-prod-' + toString(i)})
SET n.name = 'sgr-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::SecurityGroupIngress',
    n.protocol = CASE WHEN i % 5 = 0 THEN 'tcp/5432' WHEN i % 4 = 0 THEN 'tcp/443' ELSE 'tcp/8080' END,
    n.description = 'Security group rule for a specific network allowance. It is intentionally terse, so the useful meaning comes from the connected security groups and resource descriptions.';

UNWIND range(1, 16) AS i
MERGE (n:Entity:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-prod-' + toString(i)})
SET n.name = 'profile-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::InstanceProfile',
    n.description = 'Instance profile attached to one EC2 resource. It keeps identity separate from compute and forces access reasoning through role and policy resources.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsIamRole {id: 'aws:iam-role:role-commerce-prod-' + toString(i)})
SET n.name = 'role-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::Role',
    n.description = 'IAM role used by a small group of commerce compute resources. The purpose is only hinted at by the policies and storage or queue resources connected nearby.';

UNWIND range(1, 20) AS i
MERGE (n:Entity:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i)})
SET n.name = 'policy-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::Policy',
    n.description = CASE
      WHEN i <= 8 THEN 'IAM policy that mediates object storage access for a production commerce path. The exact read or write purpose is intentionally implied by neighboring bucket descriptions.'
      WHEN i <= 16 THEN 'IAM policy that mediates database connectivity for a production commerce path. The surrounding RDS node gives the better clue about whether the data is product, order, or fulfillment shaped.'
      ELSE 'IAM policy that mediates queue access for background or event handoff behavior. The semantic direction is vague on purpose for indexing and reasoning exercises.'
    END;

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsS3Bucket {id: 'aws:s3:bucket-commerce-prod-' + toString(i)})
SET n.name = 'bucket-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::S3::Bucket',
    n.encryption = CASE WHEN i % 2 = 0 THEN 'SSE-KMS' ELSE 'SSE-S3' END,
    n.description = CASE
      WHEN i <= 3 THEN 'S3 bucket containing product-adjacent objects for the commerce environment. The contents may be useful to customer-facing or product-information code paths.'
      WHEN i <= 6 THEN 'S3 bucket containing order-adjacent artifacts in the commerce environment. It might hold generated files, snapshots, or handoff material.'
      ELSE 'S3 bucket containing operational exports for the commerce environment. Its purpose is deliberately broad and should be inferred from adjacent policies and dashboards.'
    END;

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsS3BucketPolicy {id: 'aws:s3-policy:bucket-commerce-prod-' + toString(i)})
SET n.name = 'bucket-commerce-prod-' + toString(i) + '-policy',
    n.source = 'aws',
    n.resourceType = 'AWS::S3::BucketPolicy',
    n.description = 'Bucket policy attached to a concrete S3 bucket. It adds granularity between identity policy and object storage, with only light hints about the business purpose.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsKmsKey {id: 'aws:kms:key-commerce-prod-' + toString(i)})
SET n.name = 'key-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::KMS::Key',
    n.description = 'KMS key used by selected storage resources in the commerce footprint. It is a security-adjacent resource whose meaning comes from the encrypted bucket or database near it.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsRdsInstance {id: 'aws:rds:rds-commerce-prod-' + toString(i)})
SET n.name = 'rds-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBInstance',
    n.engine = 'postgres',
    n.multiAz = i % 2 = 0,
    n.description = CASE
      WHEN i <= 3 THEN 'PostgreSQL instance with product or inventory-shaped data in the production commerce environment. It is intentionally not labeled as an application service.'
      WHEN i <= 6 THEN 'PostgreSQL instance with order or payment-adjacent data in the production commerce environment. Nearby policies and monitors give the rest of the story.'
      ELSE 'PostgreSQL instance with fulfillment or operational state in the production commerce environment. It is a concrete data resource, not a derived domain node.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsRdsParameterGroup {id: 'aws:rds-parameter-group:pg-commerce-prod-' + toString(i)})
SET n.name = 'pg-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBParameterGroup',
    n.description = 'RDS parameter group for a cluster of commerce database settings. It is included so database ownership and tuning context are not compressed into a single node.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsRdsOptionGroup {id: 'aws:rds-option-group:og-commerce-prod-' + toString(i)})
SET n.name = 'og-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::OptionGroup',
    n.description = 'RDS option group attached to database resources. Its description is intentionally thin because most semantics should be recovered from neighboring resources.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsDbSubnetGroup {id: 'aws:db-subnet-group:dbsubnet-commerce-prod-' + toString(i)})
SET n.name = 'dbsubnet-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBSubnetGroup',
    n.description = 'Database subnet group for part of the commerce data tier. It provides placement context without becoming an environment node.';

UNWIND range(1, 16) AS i
MERGE (n:Entity:AwsSqsQueue {id: 'aws:sqs:queue-commerce-prod-' + toString(i)})
SET n.name = 'queue-commerce-prod-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::SQS::Queue',
    n.fifo = i IN [4, 8, 12, 16],
    n.description = CASE
      WHEN i <= 4 THEN 'SQS queue for purchase or order-adjacent events in the commerce environment. The exact producer and consumer are left to graph traversal.'
      WHEN i <= 8 THEN 'SQS queue for fulfillment-adjacent work in the commerce environment. It points toward slower background processing without naming a service node.'
      WHEN i <= 12 THEN 'SQS queue for catalog, stock, or product refresh work. It is deliberately vague so indexing has to use both text and graph neighborhood.'
      ELSE 'SQS queue used as a dead-letter or operational buffer. It adds failure-handling granularity around asynchronous commerce work.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:GitHubRepository {id: 'github:repo:acme-commerce/repo-commerce-prod-' + toString(i)})
SET n.name = 'acme-commerce/repo-commerce-prod-' + toString(i),
    n.source = 'github',
    n.resourceType = 'GitHub::Repository',
    n.defaultBranch = 'main',
    n.description = CASE i
      WHEN 1 THEN 'Repository near the customer-entry part of the commerce system. It contains production code, but the graph leaves the runtime purpose embedded in text and deployment edges.'
      WHEN 2 THEN 'Repository near product information behavior. It is one of several source resources that eventually reach EC2 through workflow nodes.'
      WHEN 3 THEN 'Repository near order-flow behavior. It gives source-control context for a production path without creating a separate service node.'
      ELSE 'Repository near fulfillment or worker behavior. Its purpose is intentionally a little fuzzy for retrieval exercises.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:GitHubWorkflow {id: 'github:workflow:repo-commerce-prod-' + toString(i) + ':deploy-prod'})
SET n.name = 'repo-commerce-prod-' + toString(i) + '/deploy-prod.yml',
    n.source = 'github',
    n.resourceType = 'GitHub::ActionsWorkflow',
    n.description = 'GitHub Actions workflow that moves one source path toward production compute. It carries deployment and environment meaning in a concrete workflow resource.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:DatadogMonitor {id: 'datadog:monitor:commerce-' + toString(i)})
SET n.name = 'commerce-prod-monitor-' + toString(i),
    n.source = 'datadog',
    n.resourceType = 'Datadog::Monitor',
    n.severity = CASE WHEN i IN [3, 4] THEN 'critical' ELSE 'warning' END,
    n.description = CASE
      WHEN i <= 2 THEN 'Datadog monitor watching customer-adjacent latency or availability in production. It is vague enough that related compute must be inspected.'
      WHEN i <= 4 THEN 'Datadog monitor watching order-flow health in production. It hints at business impact without creating a checkout node.'
      WHEN i <= 6 THEN 'Datadog monitor watching queue depth or worker lag in production. It is tied to asynchronous work through resource edges.'
      ELSE 'Datadog monitor watching database or storage pressure in production. The affected purpose depends on the neighboring resource.'
    END;

MERGE (n:Entity:DatadogDashboard {id: 'datadog:dashboard:commerce-prod-overview'})
SET n.name = 'commerce-prod-overview',
    n.source = 'datadog',
    n.resourceType = 'Datadog::Dashboard',
    n.description = 'Dashboard for the production commerce footprint. It collects signals from concrete compute, queue, storage, and database resources while leaving service and environment semantics in descriptions.';

MATCH (vpc:AwsVpc {id: 'aws:vpc:vpc-042ecomm-prod'})
WITH vpc
MATCH (n:Entity)
WHERE n:AwsSubnet OR n:AwsRouteTable OR n:AwsNetworkAcl OR n:AwsSecurityGroup OR n:AwsLoadBalancer
MERGE (vpc)-[:CONTAINS]->(n);

MATCH (vpc:AwsVpc {id: 'aws:vpc:vpc-042ecomm-prod'}), (igw:AwsInternetGateway {id: 'aws:igw:igw-ecomm-prod'})
MERGE (vpc)-[:ATTACHED_TO]->(igw);

UNWIND range(1, 6) AS i
MATCH (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-prod-' + toString(i)})
MATCH (routeTable:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-prod-' + toString(i)})
MATCH (acl:AwsNetworkAcl {id: 'aws:nacl:acl-ecomm-prod-' + toString(i)})
MERGE (subnet)-[:USES_ROUTE_TABLE]->(routeTable)
MERGE (subnet)-[:USES_NETWORK_ACL]->(acl);

UNWIND range(1, 3) AS i
MATCH (nat:AwsNatGateway {id: 'aws:nat:nat-ecomm-prod-' + toString(i)})
MATCH (eip:AwsElasticIp {id: 'aws:eip:eip-nat-ecomm-prod-' + toString(i)})
MATCH (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-prod-' + toString(i)})
MATCH (routeTable:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-prod-' + toString(i + 3)})
MERGE (subnet)-[:HOSTS]->(nat)
MERGE (nat)-[:USES_ADDRESS]->(eip)
MERGE (routeTable)-[:ROUTES_THROUGH]->(nat);

MATCH (igw:AwsInternetGateway {id: 'aws:igw:igw-ecomm-prod'})
UNWIND range(1, 3) AS i
MATCH (routeTable:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-prod-' + toString(i)})
MERGE (routeTable)-[:ROUTES_THROUGH]->(igw);

MATCH (alb:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-prod'}), (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-prod-1'})
MERGE (subnet)-[:HOSTS]->(alb);

UNWIND range(1, 16) AS i
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(i), 2)})
MATCH (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-prod-' + toString(1 + (i % 6))})
MATCH (profile:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-prod-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-prod-' + toString(1 + (i % 8))})
MERGE (subnet)-[:HOSTS]->(instance)
MERGE (instance)-[:USES_INSTANCE_PROFILE]->(profile)
MERGE (instance)-[:PROTECTED_BY]->(sg);

UNWIND range(1, 16) AS i
MATCH (profile:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-prod-' + toString(i)})
MATCH (role:AwsIamRole {id: 'aws:iam-role:role-commerce-prod-' + toString(1 + ((i - 1) % 8))})
MERGE (profile)-[:ASSUMES_ROLE]->(role);

UNWIND range(1, 4) AS i
MATCH (template:AwsLaunchTemplate {id: 'aws:launch-template:lt-commerce-prod-' + toString(i)})
MATCH (asg:AwsAutoScalingGroup {id: 'aws:asg:asg-commerce-prod-' + toString(i)})
MERGE (asg)-[:USES_LAUNCH_TEMPLATE]->(template);

UNWIND range(1, 16) AS i
MATCH (asg:AwsAutoScalingGroup {id: 'aws:asg:asg-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(i), 2)})
MERGE (asg)-[:MANAGES]->(instance);

MATCH (alb:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-prod'})
UNWIND range(1, 4) AS i
MATCH (tg:AwsTargetGroup {id: 'aws:target-group:tg-commerce-prod-' + toString(i)})
MERGE (alb)-[:USES_TARGET_GROUP]->(tg);

UNWIND range(1, 16) AS i
MATCH (tg:AwsTargetGroup {id: 'aws:target-group:tg-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(i), 2)})
MERGE (tg)-[:TARGETS]->(instance);

UNWIND range(1, 20) AS i
MATCH (rule:AwsSecurityGroupRule {id: 'aws:sg-rule:sgr-commerce-prod-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-prod-' + toString(1 + ((i - 1) % 8))})
MATCH (peer:AwsSecurityGroup {id: 'aws:sg:sg-commerce-prod-' + toString(1 + (i % 8))})
MERGE (sg)-[:HAS_RULE]->(rule)
MERGE (rule)-[:REFERENCES]->(peer);

UNWIND range(1, 5) AS lane
MATCH (source:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(lane), 2)})
MATCH (target:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(lane + 4), 2)})
MERGE (source)-[:CALLS]->(target);

UNWIND range(1, 4) AS lane
MATCH (source:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(lane + 8), 2)})
MATCH (target:AwsEc2Instance {id: 'aws:ec2:i-ecomm-prod-' + right('00' + toString(lane + 12), 2)})
MERGE (source)-[:CALLS]->(target);

UNWIND range(1, 8) AS i
MATCH (role:AwsIamRole {id: 'aws:iam-role:role-commerce-prod-' + toString(i)})
MATCH (policyA:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i)})
MATCH (policyB:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i + 8)})
MATCH (policyC:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(17 + ((i - 1) % 4))})
MERGE (role)-[:ATTACHED_POLICY]->(policyA)
MERGE (role)-[:ATTACHED_POLICY]->(policyB)
MERGE (role)-[:ATTACHED_POLICY]->(policyC);

UNWIND range(1, 8) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i)})
MATCH (bucket:AwsS3Bucket {id: 'aws:s3:bucket-commerce-prod-' + toString(i)})
MATCH (bucketPolicy:AwsS3BucketPolicy {id: 'aws:s3-policy:bucket-commerce-prod-' + toString(i)})
MERGE (policy)-[:ALIGNS_WITH]->(bucketPolicy)
MERGE (bucketPolicy)-[:APPLIES_TO]->(bucket)
MERGE (policy)-[:GRANTS_ACCESS_TO]->(bucketPolicy);

UNWIND range(1, 8) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i + 8)})
MATCH (db:AwsRdsInstance {id: 'aws:rds:rds-commerce-prod-' + toString(i)})
MERGE (policy)-[:GRANTS_ACCESS_TO]->(db);

UNWIND range(17, 20) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-prod-' + toString(i)})
UNWIND range(1, 4) AS offset
MATCH (queue:AwsSqsQueue {id: 'aws:sqs:queue-commerce-prod-' + toString(((i - 17) * 4) + offset)})
MERGE (policy)-[:GRANTS_ACCESS_TO]->(queue);

UNWIND range(1, 8) AS i
MATCH (bucket:AwsS3Bucket {id: 'aws:s3:bucket-commerce-prod-' + toString(i)})
MATCH (key:AwsKmsKey {id: 'aws:kms:key-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MERGE (bucket)-[:ENCRYPTED_BY]->(key);

UNWIND range(1, 8) AS i
MATCH (db:AwsRdsInstance {id: 'aws:rds:rds-commerce-prod-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-prod-' + toString(1 + (i % 8))})
MATCH (param:AwsRdsParameterGroup {id: 'aws:rds-parameter-group:pg-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MATCH (optionGroup:AwsRdsOptionGroup {id: 'aws:rds-option-group:og-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MATCH (subnetGroup:AwsDbSubnetGroup {id: 'aws:db-subnet-group:dbsubnet-commerce-prod-' + toString(1 + ((i - 1) % 4))})
MERGE (db)-[:PROTECTED_BY]->(sg)
MERGE (db)-[:USES_PARAMETER_GROUP]->(param)
MERGE (db)-[:USES_OPTION_GROUP]->(optionGroup)
MERGE (db)-[:USES_DB_SUBNET_GROUP]->(subnetGroup);

UNWIND range(1, 4) AS i
MATCH (queue:AwsSqsQueue {id: 'aws:sqs:queue-commerce-prod-' + toString(i)})
MATCH (dlq:AwsSqsQueue {id: 'aws:sqs:queue-commerce-prod-' + toString(i + 12)})
MERGE (queue)-[:REDRIVES_TO]->(dlq);

UNWIND range(1, 4) AS i
MATCH (repo:GitHubRepository {id: 'github:repo:acme-commerce/repo-commerce-prod-' + toString(i)})
MATCH (workflow:GitHubWorkflow {id: 'github:workflow:repo-commerce-prod-' + toString(i) + ':deploy-prod'})
MATCH (asg:AwsAutoScalingGroup {id: 'aws:asg:asg-commerce-prod-' + toString(i)})
MERGE (repo)-[:HAS_WORKFLOW]->(workflow)
MERGE (workflow)-[:DEPLOYS_TO]->(asg);

UNWIND range(1, 8) AS i
MATCH (monitor:DatadogMonitor {id: 'datadog:monitor:commerce-' + toString(i)})
MATCH (target:Entity)
WHERE target.id = CASE
  WHEN i = 1 THEN 'aws:alb:alb-commerce-entry-prod'
  WHEN i = 2 THEN 'aws:ec2:i-ecomm-prod-01'
  WHEN i = 3 THEN 'aws:ec2:i-ecomm-prod-09'
  WHEN i = 4 THEN 'aws:rds:rds-commerce-prod-4'
  WHEN i = 5 THEN 'aws:sqs:queue-commerce-prod-5'
  WHEN i = 6 THEN 'aws:sqs:queue-commerce-prod-8'
  WHEN i = 7 THEN 'aws:s3:bucket-commerce-prod-7'
  ELSE 'aws:rds:rds-commerce-prod-8'
END
MERGE (monitor)-[:MONITORS]->(target);

MATCH (dashboard:DatadogDashboard {id: 'datadog:dashboard:commerce-prod-overview'})
MATCH (n:Entity)
WHERE n:AwsLoadBalancer OR n:AwsEc2Instance OR n:AwsSqsQueue OR n:AwsRdsInstance OR n:AwsS3Bucket OR n:DatadogMonitor
MERGE (dashboard)-[:VISUALIZES]->(n);

MERGE (n:Entity:AwsVpc {id: 'aws:vpc:vpc-042ecomm-dev'})
SET n.name = 'vpc-042ecomm-dev',
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::VPC',
    n.cidr = '10.52.0.0/16',
    n.description = 'Dev-flavored network boundary for a smaller commerce footprint. It resembles production enough for rehearsal work, but the wording leaves ownership and service mapping to nearby resources.';

UNWIND range(1, 3) AS i
MERGE (n:Entity:AwsSubnet {id: 'aws:subnet:subnet-ecomm-dev-' + toString(i)})
SET n.name = 'subnet-ecomm-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::Subnet',
    n.availabilityZone = CASE WHEN i % 2 = 0 THEN 'us-east-1b' ELSE 'us-east-1a' END,
    n.cidr = '10.52.' + toString(i) + '.0/24',
    n.description = 'Subnet in the dev commerce VPC. It is intentionally smaller and less redundant than prod, but it still carries realistic placement context for application and data resources.';

UNWIND range(1, 3) AS i
MERGE (n:Entity:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-dev-' + toString(i)})
SET n.name = 'rtb-ecomm-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::RouteTable',
    n.description = 'Route table for a dev slice of the commerce network. It hints at test traffic and internal reachability without creating an environment node.';

UNWIND range(1, 3) AS i
MERGE (n:Entity:AwsNetworkAcl {id: 'aws:nacl:acl-ecomm-dev-' + toString(i)})
SET n.name = 'acl-ecomm-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::NetworkAcl',
    n.description = 'Network ACL for the dev commerce area. It is concrete infrastructure, with environment semantics only in the name and description.';

MERGE (n:Entity:AwsInternetGateway {id: 'aws:igw:igw-ecomm-dev'})
SET n.name = 'igw-ecomm-dev',
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::InternetGateway',
    n.description = 'Internet gateway for the dev commerce VPC. It supports lightweight external access for validation flows rather than the main customer path.';

MERGE (n:Entity:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-dev'})
SET n.name = 'alb-commerce-entry-dev',
    n.source = 'aws',
    n.resourceType = 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    n.dnsName = 'commerce-dev.acme.example',
    n.description = 'Application load balancer for a dev-facing commerce entry path. It resembles the production edge but is described as a validation surface rather than a customer-critical resource.';

UNWIND range(1, 2) AS i
MERGE (n:Entity:AwsTargetGroup {id: 'aws:target-group:tg-commerce-dev-' + toString(i)})
SET n.name = 'tg-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::ElasticLoadBalancingV2::TargetGroup',
    n.protocol = 'HTTP',
    n.description = 'Target group for a dev compute lane. It gives enough structure for routing analysis without a derived service node.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(i), 2)})
SET n.name = 'i-ecomm-dev-' + right('00' + toString(i), 2),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::Instance',
    n.instanceId = 'i-ecomm-dev-' + right('00' + toString(i), 2),
    n.instanceType = CASE WHEN i IN [3, 4] THEN 't3.medium' ELSE 't3.small' END,
    n.description = CASE ((i - 1) % 4)
      WHEN 0 THEN 'Dev EC2 instance near a web-entry path for commerce validation. It is smaller than the production lane and mostly useful for rehearsing user-facing changes.'
      WHEN 1 THEN 'Dev EC2 instance near product-information behavior. It carries enough catalog-like context for tests without implying production ownership.'
      WHEN 2 THEN 'Dev EC2 instance near order-flow experiments. It is suitable for checkout-like validation and lower-risk event handoffs.'
      ELSE 'Dev EC2 instance near fulfillment-style background work. It is intentionally modest and points toward queue-driven testing.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsSecurityGroup {id: 'aws:sg:sg-commerce-dev-' + toString(i)})
SET n.name = 'sg-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::SecurityGroup',
    n.description = 'Security group for one dev resource slice. It mirrors production concepts but keeps the environment distinction inside resource text.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsSecurityGroupRule {id: 'aws:sg-rule:sgr-commerce-dev-' + toString(i)})
SET n.name = 'sgr-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::EC2::SecurityGroupIngress',
    n.protocol = CASE WHEN i % 4 = 0 THEN 'tcp/5432' ELSE 'tcp/8080' END,
    n.description = 'Security group rule for a dev network allowance. Its semantics are deliberately sparse and depend on attached groups and compute descriptions.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-dev-' + toString(i)})
SET n.name = 'profile-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::InstanceProfile',
    n.description = 'Instance profile for a dev EC2 host. Identity is separated from compute so access reasoning still goes through role and policy resources.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsIamRole {id: 'aws:iam-role:role-commerce-dev-' + toString(i)})
SET n.name = 'role-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::Role',
    n.description = 'IAM role for dev commerce compute. It is lower-stakes than prod but still uses concrete policy resources to describe storage, database, and queue access.';

UNWIND range(1, 10) AS i
MERGE (n:Entity:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i)})
SET n.name = 'policy-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::IAM::Policy',
    n.description = CASE
      WHEN i <= 4 THEN 'Dev IAM policy for object storage access. It supports validation fixtures and lower-risk artifacts without saying which application path owns them.'
      WHEN i <= 8 THEN 'Dev IAM policy for database connectivity. The nearby RDS resource carries the better hint about the kind of data being exercised.'
      ELSE 'Dev IAM policy for queue access. It is useful for replay and integration-style testing around asynchronous commerce work.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsS3Bucket {id: 'aws:s3:bucket-commerce-dev-' + toString(i)})
SET n.name = 'bucket-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::S3::Bucket',
    n.encryption = 'SSE-S3',
    n.description = 'S3 bucket for dev commerce artifacts. It may contain fixture data, generated files, or object samples used by validation flows.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsS3BucketPolicy {id: 'aws:s3-policy:bucket-commerce-dev-' + toString(i)})
SET n.name = 'bucket-commerce-dev-' + toString(i) + '-policy',
    n.source = 'aws',
    n.resourceType = 'AWS::S3::BucketPolicy',
    n.description = 'Bucket policy for a dev S3 bucket. It keeps bucket authorization explicit for the vector chunking exercise.';

UNWIND range(1, 2) AS i
MERGE (n:Entity:AwsKmsKey {id: 'aws:kms:key-commerce-dev-' + toString(i)})
SET n.name = 'key-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::KMS::Key',
    n.description = 'KMS key used by selected dev resources. It is included as concrete security infrastructure, not as a separate environment concept.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:AwsRdsInstance {id: 'aws:rds:rds-commerce-dev-' + toString(i)})
SET n.name = 'rds-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBInstance',
    n.engine = 'postgres',
    n.multiAz = false,
    n.description = CASE
      WHEN i <= 2 THEN 'Dev PostgreSQL instance with product or order-shaped data. It is intentionally smaller and more disposable than production resources.'
      ELSE 'Dev PostgreSQL instance with fulfillment or operational test state. It exists for validation, replay, or integration exercises.'
    END;

UNWIND range(1, 2) AS i
MERGE (n:Entity:AwsRdsParameterGroup {id: 'aws:rds-parameter-group:pg-commerce-dev-' + toString(i)})
SET n.name = 'pg-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBParameterGroup',
    n.description = 'RDS parameter group for dev database settings. It keeps database configuration granular without modeling dev as a node.';

UNWIND range(1, 2) AS i
MERGE (n:Entity:AwsRdsOptionGroup {id: 'aws:rds-option-group:og-commerce-dev-' + toString(i)})
SET n.name = 'og-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::OptionGroup',
    n.description = 'RDS option group attached to dev database resources. Its semantics are intentionally light.';

UNWIND range(1, 2) AS i
MERGE (n:Entity:AwsDbSubnetGroup {id: 'aws:db-subnet-group:dbsubnet-commerce-dev-' + toString(i)})
SET n.name = 'dbsubnet-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::RDS::DBSubnetGroup',
    n.description = 'DB subnet group for dev database placement. It is concrete infrastructure with dev context kept in the description.';

UNWIND range(1, 8) AS i
MERGE (n:Entity:AwsSqsQueue {id: 'aws:sqs:queue-commerce-dev-' + toString(i)})
SET n.name = 'queue-commerce-dev-' + toString(i),
    n.source = 'aws',
    n.resourceType = 'AWS::SQS::Queue',
    n.fifo = i IN [4, 8],
    n.description = CASE
      WHEN i <= 4 THEN 'Dev SQS queue for order or catalog-adjacent event tests. It is meant for lower-risk replay and integration validation.'
      ELSE 'Dev SQS queue for worker-style or dead-letter testing. It mirrors production patterns in a smaller environment.'
    END;

UNWIND range(1, 4) AS i
MERGE (n:Entity:GitHubRepository {id: 'github:repo:acme-commerce/repo-commerce-dev-' + toString(i)})
SET n.name = 'acme-commerce/repo-commerce-dev-' + toString(i),
    n.source = 'github',
    n.resourceType = 'GitHub::Repository',
    n.defaultBranch = 'main',
    n.description = 'GitHub repository used around dev commerce validation. The text hints at environment and purpose without introducing a service or environment node.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:GitHubWorkflow {id: 'github:workflow:repo-commerce-dev-' + toString(i) + ':deploy-dev'})
SET n.name = 'repo-commerce-dev-' + toString(i) + '/deploy-dev.yml',
    n.source = 'github',
    n.resourceType = 'GitHub::ActionsWorkflow',
    n.description = 'GitHub Actions workflow that deploys one source path toward dev compute. It makes the dev environment visible as resource metadata only.';

UNWIND range(1, 4) AS i
MERGE (n:Entity:DatadogMonitor {id: 'datadog:monitor:commerce-dev-' + toString(i)})
SET n.name = 'commerce-dev-monitor-' + toString(i),
    n.source = 'datadog',
    n.resourceType = 'Datadog::Monitor',
    n.severity = 'warning',
    n.description = 'Datadog monitor for dev commerce validation. It watches lower-stakes latency, queue, database, or storage signals and keeps environment context in text.';

MERGE (n:Entity:DatadogDashboard {id: 'datadog:dashboard:commerce-dev-overview'})
SET n.name = 'commerce-dev-overview',
    n.source = 'datadog',
    n.resourceType = 'Datadog::Dashboard',
    n.description = 'Dashboard for the dev commerce footprint. It groups concrete resources used for validation without modeling dev as a standalone node.';

MATCH (vpc:AwsVpc {id: 'aws:vpc:vpc-042ecomm-dev'})
MATCH (n:Entity)
WHERE n.id STARTS WITH 'aws:subnet:subnet-ecomm-dev-'
   OR n.id STARTS WITH 'aws:route-table:rtb-ecomm-dev-'
   OR n.id STARTS WITH 'aws:nacl:acl-ecomm-dev-'
   OR n.id STARTS WITH 'aws:sg:sg-commerce-dev-'
   OR n.id = 'aws:alb:alb-commerce-entry-dev'
MERGE (vpc)-[:CONTAINS]->(n);

MATCH (vpc:AwsVpc {id: 'aws:vpc:vpc-042ecomm-dev'}), (igw:AwsInternetGateway {id: 'aws:igw:igw-ecomm-dev'})
MERGE (vpc)-[:ATTACHED_TO]->(igw);

UNWIND range(1, 3) AS i
MATCH (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-dev-' + toString(i)})
MATCH (routeTable:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-dev-' + toString(i)})
MATCH (acl:AwsNetworkAcl {id: 'aws:nacl:acl-ecomm-dev-' + toString(i)})
MERGE (subnet)-[:USES_ROUTE_TABLE]->(routeTable)
MERGE (subnet)-[:USES_NETWORK_ACL]->(acl);

MATCH (igw:AwsInternetGateway {id: 'aws:igw:igw-ecomm-dev'})
UNWIND range(1, 3) AS i
MATCH (routeTable:AwsRouteTable {id: 'aws:route-table:rtb-ecomm-dev-' + toString(i)})
MERGE (routeTable)-[:ROUTES_THROUGH]->(igw);

MATCH (alb:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-dev'}), (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-dev-1'})
MERGE (subnet)-[:HOSTS]->(alb);

UNWIND range(1, 8) AS i
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(i), 2)})
MATCH (subnet:AwsSubnet {id: 'aws:subnet:subnet-ecomm-dev-' + toString(1 + (i % 3))})
MATCH (profile:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-dev-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-dev-' + toString(1 + (i % 4))})
MERGE (subnet)-[:HOSTS]->(instance)
MERGE (instance)-[:USES_INSTANCE_PROFILE]->(profile)
MERGE (instance)-[:PROTECTED_BY]->(sg);

UNWIND range(1, 8) AS i
MATCH (profile:AwsIamInstanceProfile {id: 'aws:instance-profile:profile-commerce-dev-' + toString(i)})
MATCH (role:AwsIamRole {id: 'aws:iam-role:role-commerce-dev-' + toString(1 + ((i - 1) % 4))})
MERGE (profile)-[:ASSUMES_ROLE]->(role);

UNWIND range(1, 2) AS i
MATCH (tg:AwsTargetGroup {id: 'aws:target-group:tg-commerce-dev-' + toString(i)})
MATCH (alb:AwsLoadBalancer {id: 'aws:alb:alb-commerce-entry-dev'})
MERGE (alb)-[:USES_TARGET_GROUP]->(tg);

UNWIND range(1, 8) AS i
MATCH (tg:AwsTargetGroup {id: 'aws:target-group:tg-commerce-dev-' + toString(1 + ((i - 1) % 2))})
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(i), 2)})
MERGE (tg)-[:TARGETS]->(instance);

UNWIND range(1, 8) AS i
MATCH (rule:AwsSecurityGroupRule {id: 'aws:sg-rule:sgr-commerce-dev-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-dev-' + toString(1 + ((i - 1) % 4))})
MATCH (peer:AwsSecurityGroup {id: 'aws:sg:sg-commerce-dev-' + toString(1 + (i % 4))})
MERGE (sg)-[:HAS_RULE]->(rule)
MERGE (rule)-[:REFERENCES]->(peer);

UNWIND range(1, 4) AS lane
MATCH (source:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(lane), 2)})
MATCH (target:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(lane + 4), 2)})
MERGE (source)-[:CALLS]->(target);

UNWIND range(1, 4) AS i
MATCH (role:AwsIamRole {id: 'aws:iam-role:role-commerce-dev-' + toString(i)})
MATCH (policyA:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i)})
MATCH (policyB:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i + 4)})
MATCH (policyC:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(9 + ((i - 1) % 2))})
MERGE (role)-[:ATTACHED_POLICY]->(policyA)
MERGE (role)-[:ATTACHED_POLICY]->(policyB)
MERGE (role)-[:ATTACHED_POLICY]->(policyC);

UNWIND range(1, 4) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i)})
MATCH (bucket:AwsS3Bucket {id: 'aws:s3:bucket-commerce-dev-' + toString(i)})
MATCH (bucketPolicy:AwsS3BucketPolicy {id: 'aws:s3-policy:bucket-commerce-dev-' + toString(i)})
MERGE (policy)-[:GRANTS_ACCESS_TO]->(bucketPolicy)
MERGE (bucketPolicy)-[:APPLIES_TO]->(bucket);

UNWIND range(1, 4) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i + 4)})
MATCH (db:AwsRdsInstance {id: 'aws:rds:rds-commerce-dev-' + toString(i)})
MERGE (policy)-[:GRANTS_ACCESS_TO]->(db);

UNWIND range(9, 10) AS i
MATCH (policy:AwsIamPolicy {id: 'aws:iam-policy:policy-commerce-dev-' + toString(i)})
UNWIND range(1, 4) AS offset
MATCH (queue:AwsSqsQueue {id: 'aws:sqs:queue-commerce-dev-' + toString(((i - 9) * 4) + offset)})
MERGE (policy)-[:GRANTS_ACCESS_TO]->(queue);

UNWIND range(1, 4) AS i
MATCH (bucket:AwsS3Bucket {id: 'aws:s3:bucket-commerce-dev-' + toString(i)})
MATCH (key:AwsKmsKey {id: 'aws:kms:key-commerce-dev-' + toString(1 + ((i - 1) % 2))})
MERGE (bucket)-[:ENCRYPTED_BY]->(key);

UNWIND range(1, 4) AS i
MATCH (db:AwsRdsInstance {id: 'aws:rds:rds-commerce-dev-' + toString(i)})
MATCH (sg:AwsSecurityGroup {id: 'aws:sg:sg-commerce-dev-' + toString(1 + (i % 4))})
MATCH (param:AwsRdsParameterGroup {id: 'aws:rds-parameter-group:pg-commerce-dev-' + toString(1 + ((i - 1) % 2))})
MATCH (optionGroup:AwsRdsOptionGroup {id: 'aws:rds-option-group:og-commerce-dev-' + toString(1 + ((i - 1) % 2))})
MATCH (subnetGroup:AwsDbSubnetGroup {id: 'aws:db-subnet-group:dbsubnet-commerce-dev-' + toString(1 + ((i - 1) % 2))})
MERGE (db)-[:PROTECTED_BY]->(sg)
MERGE (db)-[:USES_PARAMETER_GROUP]->(param)
MERGE (db)-[:USES_OPTION_GROUP]->(optionGroup)
MERGE (db)-[:USES_DB_SUBNET_GROUP]->(subnetGroup);

UNWIND range(1, 4) AS i
MATCH (queue:AwsSqsQueue {id: 'aws:sqs:queue-commerce-dev-' + toString(i)})
MATCH (dlq:AwsSqsQueue {id: 'aws:sqs:queue-commerce-dev-' + toString(i + 4)})
MERGE (queue)-[:REDRIVES_TO]->(dlq);

UNWIND range(1, 4) AS i
MATCH (repo:GitHubRepository {id: 'github:repo:acme-commerce/repo-commerce-dev-' + toString(i)})
MATCH (workflow:GitHubWorkflow {id: 'github:workflow:repo-commerce-dev-' + toString(i) + ':deploy-dev'})
MATCH (instance:AwsEc2Instance {id: 'aws:ec2:i-ecomm-dev-' + right('00' + toString(i), 2)})
MERGE (repo)-[:HAS_WORKFLOW]->(workflow)
MERGE (workflow)-[:DEPLOYS_TO]->(instance);

UNWIND range(1, 4) AS i
MATCH (monitor:DatadogMonitor {id: 'datadog:monitor:commerce-dev-' + toString(i)})
MATCH (target:Entity)
WHERE target.id = CASE
  WHEN i = 1 THEN 'aws:alb:alb-commerce-entry-dev'
  WHEN i = 2 THEN 'aws:ec2:i-ecomm-dev-01'
  WHEN i = 3 THEN 'aws:sqs:queue-commerce-dev-5'
  ELSE 'aws:rds:rds-commerce-dev-4'
END
MERGE (monitor)-[:MONITORS]->(target);

MATCH (dashboard:DatadogDashboard {id: 'datadog:dashboard:commerce-dev-overview'})
MATCH (n:Entity)
WHERE n.id CONTAINS '-dev'
  AND (n:AwsLoadBalancer OR n:AwsEc2Instance OR n:AwsSqsQueue OR n:AwsRdsInstance OR n:AwsS3Bucket OR n:DatadogMonitor)
MERGE (dashboard)-[:VISUALIZES]->(n);

MATCH (entity:Entity)
RETURN labels(entity) AS labels, count(entity) AS count
ORDER BY labels;
