
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "private": {
          Tables: {
            "identity_blocks": {
                  Row: {
                    "created_at": string,"email_hmac": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email_hmac": string
                  }
                  Update: {
                    "created_at"?: string,"email_hmac"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "api_key_json":
{ Args: { "key": Omit<Database["public"]['Tables']["api_keys"]['Row'], Database["public"]['Tables']["api_keys"]['ComputedFields']> }; Returns: Json
                           },
"apply_ban":
{ Args: { "actor": string,"reason": string,"target": string }; Returns: number
                           },
"assert_admin":
{ Args: { "actor": string }; Returns: undefined
                           },
"assert_can_write_content":
{ Args: { "actor": string,"suspended_code": string }; Returns: undefined
                           },
"assert_not_banned":
{ Args: { "actor": string,"exclusive"?: boolean }; Returns: undefined
                           },
"audit":
{ Args: { "action": string,"actor_id": string,"actor_type": string,"metadata"?: Json,"target_id": string,"target_type": string }; Returns: undefined
                           },
"create_api_key":
{ Args: { "actor": string,"expires_at"?: string,"key_hash": string,"key_prefix": string,"name": string,"scopes": (string)[] }; Returns: Json
                           },
"create_appeal":
{ Args: { "actor": string,"statement": string,"target_id": string,"target_type": string }; Returns: string
                           },
"create_comment":
{ Args: { "actor": string,"content": string,"quote_id": string }; Returns: string
                           },
"create_quote":
{ Args: { "actor": string,"category": string,"commit_from": Database["public"]['Enums']["commit_source"],"content": string,"content_hash": string,"source_from": string }; Returns: string
                           },
"create_report":
{ Args: { "actor": string,"detail"?: string,"reason": Database["public"]['Enums']["report_reason"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"] }; Returns: {
              "became_under_review": boolean,"report_id": string
            }[]
                           },
"create_sanction":
{ Args: { "actor": string,"duration_days"?: number,"kind": Database["public"]['Enums']["sanction_kind"],"reason"?: string,"user_id": string }; Returns: {
              "api_keys_revoked": number,"ends_at": string,"sanction_id": string
            }[]
                           },
"default_username":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"delete_account_data":
{ Args: { "actor": string }; Returns: number
                           },
"delete_comment":
{ Args: { "actor": string,"comment_id": string }; Returns: undefined
                           },
"delete_quote":
{ Args: { "actor": string,"quote_id": string }; Returns: undefined
                           },
"hook_before_user_created":
{ Args: { "event": Json }; Returns: Json
                           },
"iso":
{ Args: { "value": string }; Returns: string
                           },
"lift_ban_effects":
{ Args: { "actor": string,"reason": string,"target": string }; Returns: undefined
                           },
"lift_sanction":
{ Args: { "actor": string,"reason": string,"sanction_id": string }; Returns: Json
                           },
"lock_standing":
{ Args: { "actor": string,"exclusive"?: boolean }; Returns: Database["public"]['Tables']["account_standing"]['Row']
                          SetofOptions: {
        from: "*"
        to: "account_standing"
        isOneToOne: true
        isSetofReturn: false
      } },
"quote_json":
{ Args: { "quote": Omit<Database["public"]['Tables']["quotes"]['Row'], Database["public"]['Tables']["quotes"]['ComputedFields']> }; Returns: Json
                           },
"raise_error":
{ Args: { "code": string,"details"?: Json }; Returns: undefined
                           },
"random_quote_fallback":
{ Args: { "categories": (string)[],"max"?: number,"min"?: number }; Returns: Json
                           },
"recalculate_standing":
{ Args: { "target": string }; Returns: boolean
                           },
"regenerate_api_key":
{ Args: { "actor": string,"key_hash": string,"key_id": string,"key_prefix": string }; Returns: Json
                           },
"reset_profile":
{ Args: { "actor": string,"reason": string,"user_id": string }; Returns: Database["public"]['Tables']["profiles"]['Row']
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_appeal":
{ Args: { "actor": string,"appeal_id": string,"decision": string,"note": string }; Returns: Json
                           },
"resolve_case":
{ Args: { "actor": string,"case_id": string,"final_reason"?: Database["public"]['Enums']["report_reason"],"note"?: string,"resolution": Database["public"]['Enums']["case_resolution"] }; Returns: Json
                           },
"restore_expired_reviews":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"revoke_api_key":
{ Args: { "actor": string,"key_id": string }; Returns: undefined
                           },
"sample_quotes":
{ Args: { "category": string,"n": number }; Returns: Json
                           },
"set_comment_pin":
{ Args: { "actor": string,"comment_id": string,"pinned": boolean }; Returns: string
                           },
"set_identity_block":
{ Args: { "blocked": boolean,"target": string }; Returns: undefined
                           },
"set_reaction":
{ Args: { "actor": string,"kind": string,"quote_id": string,"value": boolean }; Returns: {
              "active": boolean,"count": number
            }[]
                           },
"standing_json":
{ Args: { "standing": Omit<Database["public"]['Tables']["account_standing"]['Row'], Database["public"]['Tables']["account_standing"]['ComputedFields']> }; Returns: Json
                           },
"trending_quotes":
{ Args: { "categories": (string)[],"n": number }; Returns: Json
                           },
"update_comment":
{ Args: { "actor": string,"comment_id": string,"content": string }; Returns: string
                           },
"update_profile":
{ Args: { "actor": string,"allow_permanent_api_keys"?: boolean,"avatar_url"?: string,"favorites_public"?: boolean,"likes_public"?: boolean,"reduce_motion"?: boolean,"set_avatar"?: boolean,"username"?: string }; Returns: Database["public"]['Tables']["profiles"]['Row']
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"update_quote":
{ Args: { "actor": string,"category"?: string,"content"?: string,"content_hash"?: string,"quote_id": string,"source_from"?: string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "account_standing": {
                  Row: {
                    "ban_reason": string | null,"banned_at": string | null,"status": Database["public"]['Enums']["standing_status"],"strike_count": number,"suspended_until": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ban_reason"?: string | null,"banned_at"?: string | null,"status"?: Database["public"]['Enums']["standing_status"],"strike_count"?: number,"suspended_until"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "ban_reason"?: string | null,"banned_at"?: string | null,"status"?: Database["public"]['Enums']["standing_status"],"strike_count"?: number,"suspended_until"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "account_standing_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"api_keys": {
                  Row: {
                    "created_at": string,"expires_at": string | null,"id": string,"key_hash": string,"key_prefix": string,"last_used_at": string | null,"name": string,"regenerated_at": string | null,"revoked_at": string | null,"revoked_reason": string | null,"scopes": (string)[],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"key_hash": string,"key_prefix": string,"last_used_at"?: string | null,"name": string,"regenerated_at"?: string | null,"revoked_at"?: string | null,"revoked_reason"?: string | null,"scopes": (string)[],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string | null,"id"?: string,"key_hash"?: string,"key_prefix"?: string,"last_used_at"?: string | null,"name"?: string,"regenerated_at"?: string | null,"revoked_at"?: string | null,"revoked_reason"?: string | null,"scopes"?: (string)[],"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"appeals": {
                  Row: {
                    "created_at": string,"decided_at": string | null,"decided_by": string | null,"decision_note": string | null,"id": string,"sanction_id": string | null,"statement": string,"status": Database["public"]['Enums']["appeal_status"],"user_id": string,"violation_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"sanction_id"?: string | null,"statement": string,"status"?: Database["public"]['Enums']["appeal_status"],"user_id": string,"violation_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"sanction_id"?: string | null,"statement"?: string,"status"?: Database["public"]['Enums']["appeal_status"],"user_id"?: string,"violation_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "appeals_sanction_id_fkey"
      columns: ["sanction_id"]
isOneToOne: false
      referencedRelation: "sanctions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appeals_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "appeals_violation_id_fkey"
      columns: ["violation_id"]
isOneToOne: false
      referencedRelation: "violations"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_logs": {
                  Row: {
                    "action": string,"actor_id": string | null,"actor_type": string,"created_at": string,"id": number,"metadata": NonNullable<Json>,"request_id": string | null,"target_id": string | null,"target_type": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"actor_type": string,"created_at"?: string,"id"?: never,"metadata"?: NonNullable<Json>,"request_id"?: string | null,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"actor_type"?: string,"created_at"?: string,"id"?: never,"metadata"?: NonNullable<Json>,"request_id"?: string | null,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"categories": {
                  Row: {
                    "key": string,"name_en": string,"name_zh": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "key": string,"name_en": string,"name_zh": string,"sort_order": number
                  }
                  Update: {
                    "key"?: string,"name_en"?: string,"name_zh"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    
                  ]
                },"comments": {
                  Row: {
                    "content": string,"created_at": string,"edited_at": string | null,"id": string,"pinned_at": string | null,"quote_id": string,"status": Database["public"]['Enums']["comment_status"],"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content": string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"pinned_at"?: string | null,"quote_id": string,"status"?: Database["public"]['Enums']["comment_status"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "content"?: string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"pinned_at"?: string | null,"quote_id"?: string,"status"?: Database["public"]['Enums']["comment_status"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comments_quote_id_fkey"
      columns: ["quote_id"]
isOneToOne: false
      referencedRelation: "quotes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "comments_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"moderation_cases": {
                  Row: {
                    "created_at": string,"effective_reporter_count": number,"final_reason": Database["public"]['Enums']["report_reason"] | null,"id": string,"resolution": Database["public"]['Enums']["case_resolution"] | null,"resolved_at": string | null,"resolved_by": string | null,"review_expired_at": string | null,"reviewer_note": string | null,"status": Database["public"]['Enums']["case_status"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"effective_reporter_count"?: number,"final_reason"?: Database["public"]['Enums']["report_reason"] | null,"id"?: string,"resolution"?: Database["public"]['Enums']["case_resolution"] | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"review_expired_at"?: string | null,"reviewer_note"?: string | null,"status"?: Database["public"]['Enums']["case_status"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Update: {
                    "created_at"?: string,"effective_reporter_count"?: number,"final_reason"?: Database["public"]['Enums']["report_reason"] | null,"id"?: string,"resolution"?: Database["public"]['Enums']["case_resolution"] | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"review_expired_at"?: string | null,"reviewer_note"?: string | null,"status"?: Database["public"]['Enums']["case_status"],"target_id"?: string,"target_type"?: Database["public"]['Enums']["report_target"]
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "allow_permanent_api_keys": boolean,"avatar_url": string | null,"created_at": string,"deleted_at": string | null,"favorites_public": boolean,"id": string,"likes_public": boolean,"reduce_motion": boolean,"updated_at": string,"username": string,"verified": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "allow_permanent_api_keys"?: boolean,"avatar_url"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"favorites_public"?: boolean,"id": string,"likes_public"?: boolean,"reduce_motion"?: boolean,"updated_at"?: string,"username": string,"verified"?: boolean
                  }
                  Update: {
                    "allow_permanent_api_keys"?: boolean,"avatar_url"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"favorites_public"?: boolean,"id"?: string,"likes_public"?: boolean,"reduce_motion"?: boolean,"updated_at"?: string,"username"?: string,"verified"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"quote_favorites": {
                  Row: {
                    "created_at": string,"quote_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"quote_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"quote_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quote_favorites_quote_id_fkey"
      columns: ["quote_id"]
isOneToOne: false
      referencedRelation: "quotes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quote_favorites_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"quote_likes": {
                  Row: {
                    "created_at": string,"quote_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"quote_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"quote_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quote_likes_quote_id_fkey"
      columns: ["quote_id"]
isOneToOne: false
      referencedRelation: "quotes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quote_likes_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"quote_stats": {
                  Row: {
                    "comment_count": number,"favorite_count": number,"like_count": number,"quote_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comment_count"?: number,"favorite_count"?: number,"like_count"?: number,"quote_id": string,"updated_at"?: string
                  }
                  Update: {
                    "comment_count"?: number,"favorite_count"?: number,"like_count"?: number,"quote_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quote_stats_quote_id_fkey"
      columns: ["quote_id"]
isOneToOne: true
      referencedRelation: "quotes"
      referencedColumns: ["id"]
    }
                  ]
                },"quotes": {
                  Row: {
                    "category_key": string,"commit_from": Database["public"]['Enums']["commit_source"],"content": string,"content_hash": string,"created_at": string,"edited_at": string | null,"id": string,"length": number | null,"original_content": string,"random_key": number,"removed_at": string | null,"removed_reason": Database["public"]['Enums']["report_reason"] | null,"source_from": string,"status": Database["public"]['Enums']["quote_status"],"submitter_id": string,"under_review_since": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_key": string,"commit_from": Database["public"]['Enums']["commit_source"],"content": string,"content_hash": string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"length"?: never,"original_content": string,"random_key"?: number,"removed_at"?: string | null,"removed_reason"?: Database["public"]['Enums']["report_reason"] | null,"source_from": string,"status"?: Database["public"]['Enums']["quote_status"],"submitter_id": string,"under_review_since"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "category_key"?: string,"commit_from"?: Database["public"]['Enums']["commit_source"],"content"?: string,"content_hash"?: string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"length"?: never,"original_content"?: string,"random_key"?: number,"removed_at"?: string | null,"removed_reason"?: Database["public"]['Enums']["report_reason"] | null,"source_from"?: string,"status"?: Database["public"]['Enums']["quote_status"],"submitter_id"?: string,"under_review_since"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotes_category_key_fkey"
      columns: ["category_key"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "quotes_submitter_id_fkey"
      columns: ["submitter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"reports": {
                  Row: {
                    "case_id": string,"created_at": string,"detail": string | null,"id": string,"is_discounted": boolean,"reason": Database["public"]['Enums']["report_reason"],"reporter_id": string | null,"status": Database["public"]['Enums']["report_status"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"created_at"?: string,"detail"?: string | null,"id"?: string,"is_discounted"?: boolean,"reason": Database["public"]['Enums']["report_reason"],"reporter_id"?: string | null,"status"?: Database["public"]['Enums']["report_status"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Update: {
                    "case_id"?: string,"created_at"?: string,"detail"?: string | null,"id"?: string,"is_discounted"?: boolean,"reason"?: Database["public"]['Enums']["report_reason"],"reporter_id"?: string | null,"status"?: Database["public"]['Enums']["report_status"],"target_id"?: string,"target_type"?: Database["public"]['Enums']["report_target"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "reports_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "moderation_cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reports_reporter_id_fkey"
      columns: ["reporter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"sanctions": {
                  Row: {
                    "ends_at": string | null,"id": string,"issued_by": string | null,"kind": Database["public"]['Enums']["sanction_kind"],"lift_reason": string | null,"lifted_at": string | null,"lifted_by": string | null,"reason": string,"source": Database["public"]['Enums']["sanction_source"],"starts_at": string,"user_id": string,"violation_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ends_at"?: string | null,"id"?: string,"issued_by"?: string | null,"kind": Database["public"]['Enums']["sanction_kind"],"lift_reason"?: string | null,"lifted_at"?: string | null,"lifted_by"?: string | null,"reason": string,"source": Database["public"]['Enums']["sanction_source"],"starts_at"?: string,"user_id": string,"violation_id"?: string | null
                  }
                  Update: {
                    "ends_at"?: string | null,"id"?: string,"issued_by"?: string | null,"kind"?: Database["public"]['Enums']["sanction_kind"],"lift_reason"?: string | null,"lifted_at"?: string | null,"lifted_by"?: string | null,"reason"?: string,"source"?: Database["public"]['Enums']["sanction_source"],"starts_at"?: string,"user_id"?: string,"violation_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sanctions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sanctions_violation_id_fkey"
      columns: ["violation_id"]
isOneToOne: false
      referencedRelation: "violations"
      referencedColumns: ["id"]
    }
                  ]
                },"user_roles": {
                  Row: {
                    "created_at": string,"role": Database["public"]['Enums']["app_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"role": Database["public"]['Enums']["app_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"role"?: Database["public"]['Enums']["app_role"],"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"violations": {
                  Row: {
                    "case_id": string,"counts_as_strike": boolean,"created_at": string,"id": string,"overturned_at": string | null,"quote_id": string | null,"reason": Database["public"]['Enums']["report_reason"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"counts_as_strike": boolean,"created_at"?: string,"id"?: string,"overturned_at"?: string | null,"quote_id"?: string | null,"reason": Database["public"]['Enums']["report_reason"],"user_id": string
                  }
                  Update: {
                    "case_id"?: string,"counts_as_strike"?: boolean,"created_at"?: string,"id"?: string,"overturned_at"?: string | null,"quote_id"?: string | null,"reason"?: Database["public"]['Enums']["report_reason"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "violations_case_id_fkey"
      columns: ["case_id"]
isOneToOne: true
      referencedRelation: "moderation_cases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "violations_quote_id_fkey"
      columns: ["quote_id"]
isOneToOne: false
      referencedRelation: "quotes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "violations_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            [_ in never]: never
          }
          Enums: {
            "app_role": "admin","appeal_status": "pending"|"accepted"|"rejected","case_resolution": "dismiss"|"uphold"|"target_deleted","case_status": "open"|"resolved","comment_status": "visible"|"removed"|"deleted","commit_source": "web"|"api","quote_status": "published"|"under_review"|"removed"|"deleted","report_reason": "harassment"|"hate"|"sexual"|"violence"|"privacy"|"spam"|"misinformation"|"simplified_chinese"|"other","report_status": "pending"|"upheld"|"dismissed"|"voided","report_target": "quote"|"comment","sanction_kind": "submit_suspension"|"account_ban","sanction_source": "auto"|"manual","standing_status": "active"|"banned"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "private": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "app_role": ["admin"],"appeal_status": ["pending", "accepted", "rejected"],"case_resolution": ["dismiss", "uphold", "target_deleted"],"case_status": ["open", "resolved"],"comment_status": ["visible", "removed", "deleted"],"commit_source": ["web", "api"],"quote_status": ["published", "under_review", "removed", "deleted"],"report_reason": ["harassment", "hate", "sexual", "violence", "privacy", "spam", "misinformation", "simplified_chinese", "other"],"report_status": ["pending", "upheld", "dismissed", "voided"],"report_target": ["quote", "comment"],"sanction_kind": ["submit_suspension", "account_ban"],"sanction_source": ["auto", "manual"],"standing_status": ["active", "banned"]
          }
        }
} as const
