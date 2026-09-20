create_clock -name clk_alt -period 12.0 [get_ports CLK_ALT]

set_input_delay 3.5 -clock clk_alt [get_ports DIN\[\*\]]

set_multicycle_path 3 -setup -from [get_pins U_CORE/U_CTRL/q] \
  -to [get_pins U_CORE/U_FIFO/data_in]

set_false_path -from [get_pins U_CORE/U_CTRL/q] \
  -to [get_pins U_CORE/U_FIFO/rst_n] # project reset review

set_false_path -from [get_pins U_IP/U\\ SPACE/pin/a] \
  -to [get_ports DOUT\[\*\]] # escaped hierarchy
