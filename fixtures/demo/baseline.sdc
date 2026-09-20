create_clock -name clk -period 10.0 [get_ports CLK]
create_generated_clock -name pll_clk -source [get_pins U_IP/U_PLL/clkout] \
  -master_clock clk_alt -divide_by 2 [get_pins U_IP/U_PLL/clkout]

set_input_delay 2.0 -clock clk [get_ports DIN\[\*\]]
set_output_delay 1.5 -clock clk [get_ports DOUT\[\*\]]

set_false_path -from [get_pins U_CORE/U_FSM/state?0?] \
  -to [get_pins U_CORE/U_FIFO/wr_en]

set_multicycle_path 2 -setup -from [get_pins U_CORE/U_CTRL/q] \
  -to [get_pins U_CORE/U_FIFO/data_in]

set_false_path -from [get_pins U_CORE/U_CTRL/q] \
  -to [get_pins U_CORE/U_FIFO/rst_n] # legacy reset waiver @effective 2026-01-01 @expires 2026-09-21
