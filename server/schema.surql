-- SurrealDB Schema for Avalon
-- Apply with: node --env-file=../.env server/apply-schema.mjs

-- ============ ACCESS ============

DEFINE ACCESS OVERWRITE user_auth ON DATABASE TYPE RECORD
  SIGNUP (
    CREATE user SET
      email = $email,
      pass = IF $pass != NONE THEN crypto::argon2::generate($pass) ELSE NONE END,
      created = time::now(),
      lastActive = time::now()
  )
  SIGNIN (
    SELECT * FROM user WHERE
      email = $email AND
      crypto::argon2::compare(pass, $pass)
  )
  DURATION FOR TOKEN 24h, FOR SESSION 7d
;

-- ============ TABLES ============

-- user: one record per authenticated player
DEFINE TABLE OVERWRITE user SCHEMAFULL
  PERMISSIONS
    FOR select WHERE id = $auth.id
    FOR create, update, delete NONE
;
DEFINE FIELD OVERWRITE email ON user TYPE option<string>;
DEFINE FIELD OVERWRITE pass ON user TYPE option<string>;
DEFINE FIELD OVERWRITE name ON user TYPE option<string>;
DEFINE FIELD OVERWRITE lobby ON user TYPE option<string>;
DEFINE FIELD OVERWRITE lastActive ON user TYPE option<datetime>;
DEFINE FIELD OVERWRITE created ON user TYPE option<datetime>;
DEFINE FIELD OVERWRITE logs ON user TYPE option<array<record<game_log>>>;
DEFINE FIELD OVERWRITE logs.* ON user TYPE record<game_log>;
DEFINE FIELD OVERWRITE stats ON user TYPE option<object>;
DEFINE FIELD OVERWRITE stats.* ON user TYPE option<number>;
DEFINE INDEX OVERWRITE email_idx ON user FIELDS email UNIQUE;

-- lobby: one record per active game lobby
DEFINE TABLE OVERWRITE lobby SCHEMAFULL
  PERMISSIONS
    FOR select WHERE record::id($auth.id) IN users.*.uid
    FOR create, update, delete NONE
;
-- admin: the lobby owner
DEFINE FIELD OVERWRITE admin ON lobby TYPE object;
DEFINE FIELD OVERWRITE admin.uid ON lobby TYPE string;
DEFINE FIELD OVERWRITE admin.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE timeCreated ON lobby TYPE datetime;

-- users: keyed by player display name → { name, uid }
DEFINE FIELD OVERWRITE users ON lobby TYPE object;
DEFINE FIELD OVERWRITE users.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE users.*.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE users.*.uid ON lobby TYPE string;

-- game state
DEFINE FIELD OVERWRITE game ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.phase ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.timeCreated ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.players ON lobby TYPE option<array<string>>;
DEFINE FIELD OVERWRITE game.roles ON lobby TYPE option<array<string>>;
DEFINE FIELD OVERWRITE game.options ON lobby TYPE option<object>;
DEFINE FIELD OVERWRITE game.options.* ON lobby TYPE any;

-- game.missions: array of mission objects
DEFINE FIELD OVERWRITE game.missions ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.missions.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.missions.*.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.teamSize ON lobby TYPE int;
DEFINE FIELD OVERWRITE game.missions.*.failsRequired ON lobby TYPE int;
DEFINE FIELD OVERWRITE game.missions.*.team ON lobby TYPE array<string>;
DEFINE FIELD OVERWRITE game.missions.*.numFails ON lobby TYPE option<int>;
DEFINE FIELD OVERWRITE game.missions.*.proposals ON lobby TYPE array;
DEFINE FIELD OVERWRITE game.missions.*.proposals.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.proposer ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.state ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.team ON lobby TYPE array<string>;
DEFINE FIELD OVERWRITE game.missions.*.proposals.*.votes ON lobby TYPE array<string>;

-- game.outcome: set when game ends
DEFINE FIELD OVERWRITE game.outcome ON lobby TYPE option<object>;
DEFINE FIELD OVERWRITE game.outcome.state ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.outcome.message ON lobby TYPE option<string>;
DEFINE FIELD OVERWRITE game.outcome.assassinated ON lobby TYPE option<string|null>;
DEFINE FIELD OVERWRITE game.outcome.roles ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.outcome.roles.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.outcome.roles.*.name ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.outcome.roles.*.role ON lobby TYPE string;
DEFINE FIELD OVERWRITE game.outcome.roles.*.assassin ON lobby TYPE bool;
DEFINE FIELD OVERWRITE game.outcome.votes ON lobby TYPE option<array>;
DEFINE FIELD OVERWRITE game.outcome.votes.* ON lobby TYPE object;
DEFINE FIELD OVERWRITE game.outcome.votes.*.* ON lobby TYPE bool;

-- secret_state: server-only game secrets (roles, votes)
DEFINE TABLE OVERWRITE secret_state SCHEMAFULL
  PERMISSIONS NONE
;
DEFINE FIELD OVERWRITE lobby ON secret_state TYPE record<lobby>;

-- secret_state.roles: keyed by player name → role assignment
DEFINE FIELD OVERWRITE roles ON secret_state TYPE object;
DEFINE FIELD OVERWRITE roles.* ON secret_state TYPE object;
DEFINE FIELD OVERWRITE roles.*.name ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.role ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.assassin ON secret_state TYPE bool;
DEFINE FIELD OVERWRITE roles.*.team ON secret_state TYPE string;
DEFINE FIELD OVERWRITE roles.*.sees ON secret_state TYPE array<string>;

-- secret_state.votes: { mission: [{ playerName: bool }], proposal: { playerName: bool } }
DEFINE FIELD OVERWRITE votes ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.mission ON secret_state TYPE array;
DEFINE FIELD OVERWRITE votes.mission.* ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.mission.*.* ON secret_state TYPE bool;
DEFINE FIELD OVERWRITE votes.proposal ON secret_state TYPE object;
DEFINE FIELD OVERWRITE votes.proposal.* ON secret_state TYPE bool;

-- player_role: one record per player in an active game (client-visible role info)
DEFINE TABLE OVERWRITE player_role SCHEMAFULL
  PERMISSIONS
    FOR select WHERE user = $auth.id
    FOR create, update, delete NONE
;
DEFINE FIELD OVERWRITE lobby ON player_role TYPE record<lobby>;
DEFINE FIELD OVERWRITE user ON player_role TYPE record<user>;
DEFINE FIELD OVERWRITE uid ON player_role TYPE string;
DEFINE FIELD OVERWRITE name ON player_role TYPE string;
DEFINE FIELD OVERWRITE role ON player_role TYPE string;
DEFINE FIELD OVERWRITE assassin ON player_role TYPE bool;
DEFINE FIELD OVERWRITE sees ON player_role TYPE array<string>;
DEFINE INDEX OVERWRITE player_role_lookup ON player_role FIELDS lobby, user UNIQUE;

-- game_log: completed game records
DEFINE TABLE OVERWRITE game_log SCHEMAFULL
  PERMISSIONS
    FOR select FULL
    FOR create, update, delete NONE
;
DEFINE FIELD OVERWRITE timeCreated ON game_log TYPE option<string>;
DEFINE FIELD OVERWRITE timeFinished ON game_log TYPE datetime;
DEFINE FIELD OVERWRITE options ON game_log TYPE option<object>;
DEFINE FIELD OVERWRITE options.* ON game_log TYPE any;

-- game_log.missions: same structure as lobby.game.missions
DEFINE FIELD OVERWRITE missions ON game_log TYPE array;
DEFINE FIELD OVERWRITE missions.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE missions.*.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.teamSize ON game_log TYPE int;
DEFINE FIELD OVERWRITE missions.*.failsRequired ON game_log TYPE int;
DEFINE FIELD OVERWRITE missions.*.team ON game_log TYPE array<string>;
DEFINE FIELD OVERWRITE missions.*.numFails ON game_log TYPE option<int>;
DEFINE FIELD OVERWRITE missions.*.proposals ON game_log TYPE array;
DEFINE FIELD OVERWRITE missions.*.proposals.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE missions.*.proposals.*.proposer ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.proposals.*.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE missions.*.proposals.*.team ON game_log TYPE array<string>;
DEFINE FIELD OVERWRITE missions.*.proposals.*.votes ON game_log TYPE array<string>;

-- game_log.outcome: same structure as lobby.game.outcome
DEFINE FIELD OVERWRITE outcome ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.state ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.message ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.assassinated ON game_log TYPE option<string|null>;
DEFINE FIELD OVERWRITE outcome.roles ON game_log TYPE array;
DEFINE FIELD OVERWRITE outcome.roles.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.roles.*.name ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.roles.*.role ON game_log TYPE string;
DEFINE FIELD OVERWRITE outcome.roles.*.assassin ON game_log TYPE bool;
DEFINE FIELD OVERWRITE outcome.votes ON game_log TYPE array;
DEFINE FIELD OVERWRITE outcome.votes.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE outcome.votes.*.* ON game_log TYPE bool;

-- game_log.players: array of { name, uid } for each player
DEFINE FIELD OVERWRITE players ON game_log TYPE array;
DEFINE FIELD OVERWRITE players.* ON game_log TYPE object;
DEFINE FIELD OVERWRITE players.*.name ON game_log TYPE string;
DEFINE FIELD OVERWRITE players.*.uid ON game_log TYPE record<user>;

-- stats: global game statistics
DEFINE TABLE OVERWRITE stats SCHEMAFULL
  PERMISSIONS
    FOR select FULL
    FOR create, update, delete NONE
;
DEFINE FIELD OVERWRITE games ON stats TYPE option<int>;
DEFINE FIELD OVERWRITE good_wins ON stats TYPE option<int>;
DEFINE FIELD OVERWRITE playtimeSeconds ON stats TYPE option<float>;
