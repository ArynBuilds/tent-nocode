-- Bug 11 (the human walk): the typed name survives - the kebab slug stays the
-- machine identity forever; display_name is the human word on the cards.
alter table datasets add column if not exists display_name text;
alter table operations add column if not exists display_name text;
