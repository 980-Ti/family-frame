DO $$
BEGIN
  IF to_regclass('"FamilyMember"') IS NULL THEN
    RAISE NOTICE 'FamilyMember does not exist yet; this is a fresh database.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "FamilyMember"
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple family memberships exist. Inspect duplicate userId values and resolve them manually before migration.';
  END IF;
END
$$;
