export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      copilot_audit_log: {
        Row: {
          action: string
          created_at: string
          detail: Json | null
          draft_id: string | null
          id: string
          model_id: string | null
          tenant_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json | null
          draft_id?: string | null
          id?: string
          model_id?: string | null
          tenant_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json | null
          draft_id?: string | null
          id?: string
          model_id?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "copilot_audit_log_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "copilot_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "copilot_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "demo_tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_drafts: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          draft_body: string
          id: string
          message_type: string
          risk_checked_at: string | null
          risk_flags: Json | null
          status: string
          tenant_id: string
          tone: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          draft_body: string
          id?: string
          message_type: string
          risk_checked_at?: string | null
          risk_flags?: Json | null
          status?: string
          tenant_id: string
          tone: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          draft_body?: string
          id?: string
          message_type?: string
          risk_checked_at?: string | null
          risk_flags?: Json | null
          status?: string
          tenant_id?: string
          tone?: string
        }
        Relationships: [
          {
            foreignKeyName: "copilot_drafts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "demo_tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_photo_triage: {
        Row: {
          concept_prompt: string
          created_at: string
          findings: Json | null
          id: string
          photo_path: string
          segmentation: Json | null
          status: string
          tenant_id: string
        }
        Insert: {
          concept_prompt: string
          created_at?: string
          findings?: Json | null
          id?: string
          photo_path: string
          segmentation?: Json | null
          status?: string
          tenant_id: string
        }
        Update: {
          concept_prompt?: string
          created_at?: string
          findings?: Json | null
          id?: string
          photo_path?: string
          segmentation?: Json | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "copilot_photo_triage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "demo_tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_tenants: {
        Row: {
          balance_cents: number
          created_at: string
          deposit_status: string
          due_day: number
          full_name: string
          id: string
          lease_end: string
          lease_late_fee_cents: number
          lease_start: string
          possession_date: string | null
          property_label: string
          rent_cents: number
          termination_date: string | null
        }
        Insert: {
          balance_cents?: number
          created_at?: string
          deposit_status: string
          due_day: number
          full_name: string
          id?: string
          lease_end: string
          lease_late_fee_cents?: number
          lease_start: string
          possession_date?: string | null
          property_label: string
          rent_cents: number
          termination_date?: string | null
        }
        Update: {
          balance_cents?: number
          created_at?: string
          deposit_status?: string
          due_day?: number
          full_name?: string
          id?: string
          lease_end?: string
          lease_late_fee_cents?: number
          lease_start?: string
          possession_date?: string | null
          property_label?: string
          rent_cents?: number
          termination_date?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_demo_user: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
