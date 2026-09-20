create_generated_clock -name pll_alt -source [get_pins U_IP/U_PLL/altout] \
  -master_clock clk -divide_by 4 [get_pins U_IP/U_PLL/altout]

set_multicycle_path 1 -hold -from [get_pins U_CORE/U_CTRL/q] \
  -to [get_pins U_CORE/U_FIFO/data_in]

set_false_path -from [get_pins U_IP/U_MISSING/q] \
  -to [get_pins U_CORE/U_FIFO/rst_n] # stale IP name @expect 1

set_false_path -from [get_pins U_CORE/U_FIFO/D*] \
  -to [get_pins U_CORE/U_FIFO/data_in] # intentionally broad exploratory query
